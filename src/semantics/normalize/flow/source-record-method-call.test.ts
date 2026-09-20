import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachStatedModuleSet } from './targets.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import {
  recordMethodCallResultsOf,
  recordMethodCallTargetsOf,
  sourceRecordDataWritePlanOf,
  type SourceRecordOriginAuthority
} from './source-record-data.js'

const fixture = (name: string): string => resolve(`test/fixtures/record-method-${name}.ts`)

interface ProbeOptions {
  /** Entry modules by name; the first source by default. */
  readonly entries?: readonly string[]
  readonly stated?: boolean
  readonly slotClosed?: NonNullable<SourceRecordOriginAuthority['recordSlotClosed']>
}

/** Compiles `sources` and probes the FIRST one: the write plan of its last
 * `.target` receiver, and the record-method answers for its last `.get(`. */
const probe = (sources: Readonly<Record<string, string>>, options: ProbeOptions = {}) => {
  const contents = new Map(Object.entries(sources).map(([name, text]) => [fixture(name), text]))
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, types: [] }
  const host = ts.createCompilerHost(compilerOptions)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) => {
    const text = contents.get(resolve(name))
    return text === undefined ? read(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
  }
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => ({ resolvedFileName: resolve(dirname(containingFile), `${name}.ts`), extension: ts.Extension.Ts }))
  const program = ts.createProgram([...contents.keys()], compilerOptions, host)
  const checker = program.getTypeChecker()
  const files = [...contents.keys()].map((name) => program.getSourceFile(name)!)
  const flow = indexValueFlow(checker, files, wholeProgram)
  if (options.stated !== false) {
    const entries = (options.entries ?? [Object.keys(sources)[0]!]).map((name) => program.getSourceFile(fixture(name))!)
    attachStatedModuleSet(flow, { files, entries })
  }
  let receiver: ts.Expression | undefined
  let call: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'target') receiver = node.expression
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'get') call = node
    ts.forEachChild(node, visit)
  }
  visit(files[0]!)
  assert.ok(receiver)
  const argumentsByFile = new Map<ts.SourceFile, ReturnType<typeof censusArgumentsObjects>>()
  const base = closedCallableAuthorityOf(
    checker,
    flow,
    (expression) => checker.getTypeAtLocation(expression),
    (declaration) => {
      const file = declaration.getSourceFile()
      let census = argumentsByFile.get(file)
      if (!census) argumentsByFile.set(file, (census = censusArgumentsObjects(checker, [file])))
      return census.usesByOwner.get(declaration)
    }
  )
  const authority = {
    ...base,
    ...(options.slotClosed ? { recordSlotClosed: options.slotClosed } : {})
  }
  const targets = call ? recordMethodCallTargetsOf(flow, call, authority) : null
  return {
    plan: sourceRecordDataWritePlanOf(flow, receiver, 'target', authority),
    targets: targets?.map((target) => (ts.isFunctionDeclaration(target) ? target.name!.text : ts.SyntaxKind[target.kind])) ?? null,
    results: (call ? recordMethodCallResultsOf(flow, call, authority) : null)?.map((result) => result.getText()) ?? null
  }
}

/** Three's `WebGLRenderLists` shape: a factory whose record's `get` looks a
 * list up in a WeakMap-held pool, or makes one with another factory. */
const LISTS = `
  function List() { return { target: null as unknown, items: [] as unknown[] } }
  function Lists() {
    let lists = new WeakMap<object, unknown>()
    function get(scene: object, depth: number) {
      let list
      if (depth > 0) list = List()
      else list = List()
      return list
    }
    function dispose() { lists = new WeakMap() }
    return { get: get, dispose: dispose }
  }`
const USE = `
  const list = lists.get({}, 0)
  list.target = null
  lists.dispose()`
const threeShape = (between = '', factory = LISTS) => `export {};\n${factory}\n  const lists = Lists()\n${between}\n${USE}`

test('a record method call originates from the callable its slot holds', () => {
  const { plan, targets, results } = probe({ main: threeShape() })
  assert.deepEqual(targets, ['get'])
  assert.deepEqual(results, ['list'])
  assert.equal(plan?.roots.length, 1)
  assert.ok(plan?.roots[0]?.getText().includes('items'))
  assert.equal(plan?.needsDefaultPrototype, false)
})

test('shorthand, in-place function and arrow slots are closed callables', () => {
  for (const [slot, expected] of [
    ['function get() { return { target: 1 } } return { get }', 'get'],
    ['return { get: function () { return { target: 1 } } }', 'FunctionExpression'],
    ['return { get: () => ({ target: 1 }) }', 'ArrowFunction']
  ] as const) {
    const source = `export {};\nfunction Lists() { ${slot} }\nconst lists = Lists()\nconst list = lists.get()\nlist.target = 2`
    const { plan, targets } = probe({ main: source })
    assert.deepEqual(targets, [expected], slot)
    assert.equal(plan?.roots.length, 1, slot)
  }
})

test('target identity is available when normal completion values are unsupported', () => {
  const cases = [
    ['void completion', 'function get(): void { return }'],
    ['early return with fallthrough', 'function get(choice: boolean) { if (choice) return { target: 1 } }'],
    ['async completion', 'async function get() { return { target: 1 } }'],
    ['generator completion', 'function* get() { yield { target: 1 }; return { target: 1 } }']
  ] as const
  for (const [label, declaration] of cases) {
    const source = `export {};
      function Lists() { ${declaration}; return { get } }
      const lists = Lists()
      const list = lists.get()
      list.target = 2`
    const { targets, results } = probe({ main: source })
    assert.deepEqual(targets, ['get'], label)
    assert.equal(results, null, label)
  }
})

test('an imported factory is the function its module declares, closed through its enumerated importers', () => {
  const library = `function List() { return { target: null as unknown } }
    function Lists() { function get() { return List() } function dispose() {} return { get: get, dispose: dispose } }
    export { Lists }`
  const importer = `import { Lists } from './record-method-library'
    const lists = Lists()
    const list = lists.get()
    list.target = null`
  const closed = probe({ importer, library })
  assert.deepEqual(closed.targets, ['get'])
  assert.equal(closed.plan?.roots.length, 1)
  // Unstated module set, or the library an entry: its importers are not all known.
  assert.equal(probe({ importer, library }, { stated: false }).targets, null)
  assert.equal(probe({ importer, library }, { entries: ['importer', 'library'] }).plan === null, true)
})

test('a replaceable slot refuses, even under a caller closure proof', () => {
  const replaced = threeShape('  lists.get = () => ({ target: 1, items: [] })')
  assert.equal(probe({ main: replaced }).targets, null)
  assert.equal(probe({ main: replaced }).plan === null, true)
  assert.equal(probe({ main: replaced }, { slotClosed: () => true }).targets, null)
  // Through an untyped alias the flow index names no slot; the alias proof refuses the store.
  assert.equal(probe({ main: threeShape('  const alias: any = lists\n  alias.get = () => ({})') }).plan === null, true)
  // A reassigned binding may no longer be the function the literal copied.
  assert.equal(probe({ main: threeShape('', LISTS.replace('function dispose() {', 'function dispose() { get = get;')) }).targets, null)
})

test('an escaping record refuses unless the caller proves the slot closed', () => {
  const external = 'declare function external(value: unknown): void\n'
  const argument = threeShape(`  ${external}  external(lists)`)
  assert.equal(probe({ main: argument }).targets, null)
  assert.equal(probe({ main: argument }).plan === null, true)
  assert.deepEqual(probe({ main: argument }, { slotClosed: () => true }).targets, ['get'])
  // Three's own shape: the record published onto another object.
  const published = threeShape('  const renderer: { renderLists?: unknown } = {}\n  renderer.renderLists = lists')
  assert.equal(probe({ main: published }).targets, null)
  assert.deepEqual(probe({ main: published }, { slotClosed: () => true }).targets, ['get'])
  // The factory itself handed away: its callers are no longer enumerable.
  assert.equal(probe({ main: threeShape(`  ${external}  external(Lists)`) }).targets, null)
  // A sibling slot that writes through \`this\` when called as a method.
  const self = LISTS.replace('function dispose() { lists = new WeakMap() }', 'function dispose(this: any) { this.get = null }')
  assert.equal(probe({ main: threeShape('', self) }).targets, null)
})

test('a receiver that may also be a real Map is not a record', () => {
  const mixed = threeShape().replace(
    'const lists = Lists()',
    'declare const choose: boolean\n  const lists: any = choose ? Lists() : new Map<object, unknown>()'
  )
  assert.equal(probe({ main: mixed }).targets, null)
  assert.equal(probe({ main: mixed }).plan === null, true)
  // Origins all records (the one caller passes `Lists()`), but the checker
  // types the receiver as possibly a map. A parameter, so no initializer
  // narrowing hides the declared union.
  const typed = `export {};\n${LISTS}
  function use(lists: ReturnType<typeof Lists> | Map<object, any>) {
    const list = (lists as any).get({}, 0)
    list.target = null
  }
  use(Lists())`
  assert.equal(probe({ main: typed }).targets, null)
  assert.equal(probe({ main: typed }, { slotClosed: () => true }).targets, null)
  assert.equal(probe({ main: typed }, { slotClosed: () => true }).plan === null, true)
})

test('a construction whose factory can complete with a non-object refuses', () => {
  const factory = 'function F(choice: boolean): any { if (choice) return null; return { target: 1 } }'
  // The plain call's null completion adds nothing; under `new` it yields `this`.
  assert.equal(probe({ main: `export {};\n${factory}\nconst e = F(true)\ne.target = 2` }).plan?.roots.length, 1)
  assert.equal(probe({ main: `export {};\n${factory}\nconst e = new (F as any)(true)\ne.target = 2` }).plan === null, true)
})

test('a construction whose factory mentions `this` refuses', () => {
  const source = `export {};
    function F(this: any): any { this.x = 1; return { target: 1 } }
    const e = new (F as any)()
    e.target = 2`
  assert.equal(probe({ main: source }).plan === null, true)
})

test("three's `new WebGLRenderLists()` shape stays admitted", () => {
  const constructed = threeShape().replace('const lists = Lists()', 'const lists = new (Lists as any)()')
  const { plan, targets } = probe({ main: constructed })
  assert.deepEqual(targets, ['get'])
  assert.equal(plan?.roots.length, 1)
  assert.ok(plan?.roots[0]?.getText().includes('items'))
})

test('around an unseeded method cycle, the call refuses', () => {
  const cycle = `export {};
    function F() { return { get: get } }
    function get(): any { return r.get() }
    const r = F()
    const x = r.get()
    x.target = null`
  assert.equal(probe({ main: cycle }).plan === null, true)
})
