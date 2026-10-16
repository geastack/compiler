import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachStatedModuleSet } from './targets.js'
import { sourceProxyOperationFramesOf } from './source-proxy-operation.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

// Native Proxy invocation supplies the original target as the first trap
// argument. That identity is not the Proxy constructor's returned identity.
const targets = (source: string): readonly string[] | null => {
  const entry = resolve('test/fixtures/source-proxy-trap-target.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [], strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, 'export {}\n' + source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const files = program.getSourceFiles()
  const flow = indexValueFlow(checker, files, wholeProgram)
  attachStatedModuleSet(flow, { files, entries: [file], reachable: wholeProgram })
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  let parameter: ts.ParameterDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'trapTarget') parameter = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(parameter, 'fixture must contain the actual first trap argument')
  const actualParameter = parameter
  const proof = ledger.capture(() => sourceProxyOperationFramesOf(checker, flow, actualParameter))
  return proof.value?.map((frame) => frame.target.getText()).sort() ?? null
}

const operation = `set(trapTarget: object, key: PropertyKey, value: unknown) { return true }`

test('standard Proxy set supplies its actual target to a closed source handler', () => {
  assert.deepEqual(targets(`const target = {}; const handler = { ${operation} }; const proxy = new Proxy(target, handler);`), ['target'])
})

test('a shadowed Proxy constructor supplies no intrinsic trap frame', () => {
  assert.equal(targets(`declare const Proxy: any; const target = {}; const handler = { ${operation} }; new Proxy(target, handler);`), null)
})

test('a handler handed to unknown code does not have a complete invocation inventory', () => {
  assert.equal(
    targets(
      `declare function expose(value: unknown): void; const target = {}; const handler = { ${operation} }; new Proxy(target, handler); expose(handler);`
    ),
    null
  )
})

test('a mutable handler method with unknown replacement cannot authenticate its old trap', () => {
  assert.equal(
    targets(
      `declare const replacement: any; const target = {}; const handler = { ${operation} }; handler.set = replacement; new Proxy(target, handler);`
    ),
    null
  )
})

test('multiple exact Proxy retentions keep every target without aliasing the returned Proxy', () => {
  assert.deepEqual(
    targets(
      `const first = {}; const second = {}; const handler = { ${operation} }; new Proxy(first, handler); new Proxy(second, handler);`
    ),
    ['first', 'second']
  )
})

test('an unknown alternative handler does not change the retained known handler operation target', () => {
  assert.deepEqual(
    targets(
      `declare const choose: boolean; declare const other: any; const target = {}; const handler = { ${operation} }; const chosen = choose ? other : handler; new Proxy(target, chosen);`
    ),
    ['target']
  )
})

test('reflected handler mutations and hidden receiver reentry keep the operation inventory open', () => {
  assert.equal(
    targets(`const target = {}; const handler = { ${operation} }; Object.setPrototypeOf(handler, {}); new Proxy(target, handler);`),
    null
  )
  assert.equal(
    targets(
      'const target = {}; const handler = {set(trapTarget: object, key: PropertyKey, value: unknown) { this.set(Object, key, value); return true }}; new Proxy(target, handler);'
    ),
    null
  )
})

test('an exported entry handler or detached trap is not native-only invocation provenance', () => {
  assert.equal(targets(`const target = {}; export const handler = { ${operation} }; new Proxy(target, handler);`), null)
  assert.equal(
    targets(`const target = {}; const handler = { ${operation} }; const detached = handler.set; new Proxy(target, handler);`),
    null
  )
})

test('only the actual first native trap parameter has the target role', () => {
  assert.deepEqual(
    targets('const target = {}; const handler = {get(trapTarget: object, key: PropertyKey) { return 1 }}; new Proxy(target, handler);'),
    ['target']
  )
  assert.equal(
    targets(
      'const target = {}; const handler = {set(targetArg: object, trapTarget: PropertyKey, value: unknown) { return true }}; new Proxy(target, handler);'
    ),
    null
  )
})

test('real Proxy construction retains the returned identity separately from the raw target', () => {
  let raw: object | undefined
  let observed: object | undefined
  class ReturnedProxy {
    constructor() {
      raw = this
      return new Proxy(this, {
        set(target, key, value) {
          observed = target
          return Reflect.set(target, key, value)
        }
      })
    }
  }
  const result = new ReturnedProxy()
  Reflect.set(result, 'value', 1)
  assert.ok(raw)
  assert.equal(observed, raw)
  assert.notEqual(result, raw)
})
