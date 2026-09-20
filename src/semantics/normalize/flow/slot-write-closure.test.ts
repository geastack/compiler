import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

/**
 * The target-identity half of slot closure: a call through a receiver the
 * proof cannot resolve (`stir(x: any)` below, three's `geometry.getAttribute`
 * off an untyped parameter) is not a write and must not open the slot for
 * the typed call sites of the same key. Only a WRITE that may reach a family
 * instance -- named, computed, through an intrinsic mutator, or a prototype
 * replacement -- refuses the target set.
 */
const invocationTargets = (source: string, marker: (call: ts.CallExpression) => boolean): readonly ts.SignatureDeclaration[] | null => {
  const entry = resolve('test/fixtures/slot-write-closure.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  let answer: readonly ts.SignatureDeclaration[] | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && marker(node)) {
      const proof = ledger.capture(() => authority.invocationFactOf(node))
      answer = proof.value?.frames.map((frame) => frame.body) ?? null
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return answer
}

const typedCopy = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  call.expression.name.text === 'copy' &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === 'a'

const family = `
class V {
  x = 0
  copy(o: V): this { this.x = o.x; return this }
}
function stir(x: any): void { x.copy(x) }
const a = new V()
stir(JSON.parse('{}'))
`

const bodyNames = (targets: readonly ts.SignatureDeclaration[] | null): readonly string[] | null =>
  targets?.map((body) => (ts.isMethodDeclaration(body) && ts.isIdentifier(body.name) ? body.name.text : '?')) ?? null

test('a call through an unresolvable receiver does not open the slot for a typed call on an exact origin', () => {
  assert.deepEqual(bodyNames(invocationTargets(`${family}\na.copy(new V())\n`, typedCopy)), ['copy'])
})

test('a named write of the key through any receiver refuses the target set', () => {
  assert.equal(
    invocationTargets(`${family}\nfunction patch(x: any): void { x.copy = () => x }\npatch(a)\na.copy(new V())\n`, typedCopy),
    null
  )
})

test('a named write of the key on a class outside the family does not', () => {
  const source = `${family}\nclass W { copy(): void {} }\nconst w = new W()\nw.copy = () => {}\na.copy(new V())\n`
  assert.deepEqual(bodyNames(invocationTargets(source, typedCopy)), ['copy'])
})

test('a computed write whose key may be the member refuses; a numeric key cannot be', () => {
  const open = `${family}\nconst bag: any = a\nbag[String(Date.now())] = 1\na.copy(new V())\n`
  assert.equal(invocationTargets(open, typedCopy), null)
  const numeric = `${family}\nconst bag: any = a\nbag[Date.now()] = 1\na.copy(new V())\n`
  assert.deepEqual(bodyNames(invocationTargets(numeric, typedCopy)), ['copy'])
})

test('an intrinsic mutator handed a family instance refuses unless its keys are spelled and miss the member', () => {
  assert.equal(invocationTargets(`${family}\nObject.assign(a, JSON.parse('{}'))\na.copy(new V())\n`, typedCopy), null)
  assert.deepEqual(bodyNames(invocationTargets(`${family}\nObject.assign(a, { x: 2 })\na.copy(new V())\n`, typedCopy)), ['copy'])
  assert.equal(invocationTargets(`${family}\nObject.defineProperty(a, 'copy', { value: 1 })\na.copy(new V())\n`, typedCopy), null)
  assert.deepEqual(bodyNames(invocationTargets(`${family}\nObject.defineProperty(a, 'id', { value: 1 })\na.copy(new V())\n`, typedCopy)), [
    'copy'
  ])
  assert.equal(invocationTargets(`${family}\nObject.setPrototypeOf(a, null)\na.copy(new V())\n`, typedCopy), null)
})

test('replacing the family prototype refuses', () => {
  assert.equal(invocationTargets(`${family}\n;(V as any).prototype = {}\na.copy(new V())\n`, typedCopy), null)
  assert.equal(invocationTargets(`${family}\n;(V.prototype as any).copy = () => a\na.copy(new V())\n`, typedCopy), null)
})
