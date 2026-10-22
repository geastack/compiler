import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

/**
 * The `clone() { return new this.constructor().copy(this) }` idiom ties three
 * members into one cycle: `clone` constructs through the family's own
 * constructor, whose subclass body calls `setValues`, and every `copy`
 * override calls `super.copy`. Each member call's targets rest on the others'
 * slot proofs, so whichever call is asked first proves the rest NESTED, under
 * the parks its own proof holds, while that first one runs at top level with
 * nothing parked.
 *
 * An answer must not depend on which one that is. The top-level walk of the
 * family refused at a read of `copy`'s untyped `source` off the fresh clone,
 * a refusal no nested proof ever reached because the family was already
 * parked there -- so the same call resolved or refused by the order it was
 * asked in. These tests ask the cycle from every entry point, each on a fresh
 * index, and require one answer.
 */

const entry = resolve('test/fixtures/clone-cycle-entry-order.js')

const cycle = `
function cloneUniforms(src) {
  const dst = {}
  for (const u in src) {
    dst[u] = {}
    for (const p in src[u]) dst[u][p] = src[u][p]
  }
  return dst
}
class Material {
  constructor() {
    this.name = ''
    this.type = 'Material'
  }
  setValues(values) {
    if (values === undefined) return
    for (const key in values) {
      const newValue = values[key]
      if (newValue === undefined) continue
      if (this[key] === undefined) continue
      this[key] = newValue
    }
  }
  copy(source) {
    this.name = source.name
    return this
  }
  clone() {
    return new this.constructor().copy(this)
  }
}
class ShadedMaterial extends Material {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super()
    this.type = 'ShadedMaterial'
    this.uniforms = {}
    this.vertexShader = 'default'
    this.depthTest = true
    if (parameters !== undefined) this.setValues(parameters)
  }
  copy(source) {
    super.copy(source)
    this.uniforms = cloneUniforms(source.uniforms)
    this.vertexShader = source.vertexShader
    this.depthTest = source.depthTest
    return this
  }
}
class RawShadedMaterial extends ShadedMaterial {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super(parameters)
    this.type = 'RawShadedMaterial'
  }
}
class MeshMaterial extends Material {
  constructor() {
    super()
    this.type = 'MeshMaterial'
  }
}
const library = { output: { uniforms: { tDiffuse: { value: null } } }, blur: { uniforms: { envMap: { value: null } } } }
const raw = new RawShadedMaterial({ uniforms: cloneUniforms(library.output.uniforms), vertexShader: 'raw', depthTest: false })
const shader = new ShadedMaterial({ name: 'blur', uniforms: cloneUniforms(library.blur.uniforms), vertexShader: 'blurV' })
const mesh = new MeshMaterial()
mesh.name = 'mesh'
const rawCopy = raw.clone()
console.log(rawCopy.type, Object.keys(rawCopy.uniforms).join('+'), rawCopy.vertexShader, rawCopy.depthTest)
const shaderCopy = shader.clone()
console.log(shaderCopy.type, shaderCopy.name, Object.keys(shaderCopy.uniforms).join('+'), shaderCopy.vertexShader)
const meshCopy = mesh.clone()
console.log(meshCopy.type, meshCopy.name)
`

/** The member calls of the cycle, by their source text. */
const CYCLE_CALLS = [
  'new this.constructor().copy(this)',
  'this.setValues(parameters)',
  'super.copy(source)',
  'raw.clone()',
  'shader.clone()',
  'mesh.clone()'
] as const

const programOf = (source: string): { readonly checker: ts.TypeChecker; readonly file: ts.SourceFile } => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => resolve(name) === entry || fileExists(name)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry
      ? ts.createSourceFile(name, `export {};\n${source}`, version, true, ts.ScriptKind.JS)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  return { checker: program.getTypeChecker(), file: program.getSourceFile(entry)! }
}

/**
 * Every cycle call's resolved target bodies, named `Owner.member`, asked in
 * `order` on a fresh flow index. One program serves every order: the checker
 * answers the same whichever order its questions come in, and every proof
 * cache this asks through is keyed by the flow index.
 */
const answersIn = (
  program: { readonly checker: ts.TypeChecker; readonly file: ts.SourceFile },
  order: readonly string[]
): ReadonlyMap<string, string | null> => {
  const { checker, file } = program
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  const calls = new Map<string, ts.CallExpression>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (CYCLE_CALLS as readonly string[]).includes(node.getText(file))) calls.set(node.getText(file), node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(calls.size, CYCLE_CALLS.length, 'every cycle call is in the program')
  const answers = new Map<string, string | null>()
  for (const text of order) {
    const proof = ledger.capture(() => authority.invocationFactOf(calls.get(text)!))
    const bodies = proof.value?.frames.map(({ body }) => {
      const owner = body.parent
      const name = ts.isClassLike(owner) ? (owner.name?.getText(file) ?? '(anonymous)') : '-'
      return `${name}.${body.name?.getText(file) ?? '(anonymous)'}`
    })
    answers.set(text, bodies === undefined ? null : [...bodies].sort().join(' '))
  }
  return answers
}

/** Each call asked first, the rest after it in their listed order. */
const entryOrders = (): readonly (readonly string[])[] =>
  CYCLE_CALLS.map((first) => [first, ...CYCLE_CALLS.filter((call) => call !== first)])

const answersFromEveryEntry = (source: string): readonly ReadonlyMap<string, string | null>[] => {
  const program = programOf(source)
  return entryOrders().map((order) => answersIn(program, order))
}

const sameAnswers = (all: readonly ReadonlyMap<string, string | null>[]): void => {
  const [first, ...rest] = all
  for (const [index, answers] of rest.entries())
    for (const call of CYCLE_CALLS)
      assert.equal(answers.get(call), first!.get(call), `${call} asked after entering at ${CYCLE_CALLS[index + 1]}`)
}

test('every call of the clone cycle resolves the same from every entry point', () => {
  const all = answersFromEveryEntry(cycle)
  sameAnswers(all)
  assert.deepEqual(Object.fromEntries(all[0]!), {
    'new this.constructor().copy(this)': 'Material.copy ShadedMaterial.copy',
    'this.setValues(parameters)': 'Material.setValues',
    'super.copy(source)': 'Material.copy',
    'raw.clone()': 'Material.clone',
    'shader.clone()': 'Material.clone',
    'mesh.clone()': 'Material.clone'
  })
})

test('a clone whose copy also receives a record answers the same from every entry point', () => {
  // A second source for `copy`: the walk must keep the record beside the
  // material it follows, whichever proof asks first.
  for (const tail of [
    "rawCopy.copy({ name: 'plain' })",
    "const detached = rawCopy.copy; detached.call(rawCopy, { name: 'plain', uniforms: {}, vertexShader: 'v', depthTest: true })",
    "function poke(m) { m.copy({ name: 'plain', uniforms: {}, vertexShader: 'v', depthTest: true }) }\npoke(rawCopy)",
    "const held = [rawCopy]\nheld[0].copy({ name: 'plain', uniforms: {}, vertexShader: 'v', depthTest: true })",
    "const box = { held: rawCopy }\nbox.held.copy({ name: 'plain', uniforms: {}, vertexShader: 'v', depthTest: true })",
    ";[rawCopy].forEach((m) => m.copy({ name: 'plain', uniforms: {}, vertexShader: 'v', depthTest: true }))"
  ])
    sameAnswers(answersFromEveryEntry(`${cycle}\n${tail}\n`))
})

test('an untyped read off the clone that yields the clone itself is still followed', () => {
  // `rawCopy.self` names no declaration, so it is resolved through the
  // family's own `this.self = this`. That read hands back the very object the
  // family walk follows: kept locally it is closed, published it is not.
  const selfReferring = cycle.replace('    this.depthTest = true\n', '    this.depthTest = true\n    this.self = this\n')
  const kept = answersFromEveryEntry(`${selfReferring}\nconst kept = rawCopy.self\nconsole.log(kept === rawCopy)\n`)
  sameAnswers(kept)
  assert.equal(kept[0]!.get('super.copy(source)'), 'Material.copy')
  const published = answersFromEveryEntry(`${selfReferring}\nglobalThis.kept = rawCopy.self\n`)
  sameAnswers(published)
  for (const call of CYCLE_CALLS) assert.equal(published[0]!.get(call), null, call)
})
