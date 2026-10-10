import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { allOperationsOf, type CallOperation, type GetOperation } from './model.js'

test('a physical receiver upcast preserves the original logical this and immediate method selection', () => {
  const entry = resolve('test/runtime/inline-native-method-logical-receiver.runtime.ts')
  const source = `
class Root {
  value = 3
  self(): this { return this }
  read(): number { return this.value }
}
class Child extends Root {
  extra = 5
  override read(): number { return this.value + this.extra }
}
const first = new Child()
const other = new Child()
const returned: Child = first.self()
console.log(returned.value, first.read.call(other))
`
  const result = compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, source]]), includeIr: true })
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => allOperationsOf(block)))
  const constants = new Map(
    operations.flatMap((operation) => (operation.kind === 'constant' ? [[operation.result.id, operation.text]] : []))
  )
  const getOf = (key: string): GetOperation => {
    const get = operations.find(
      (operation): operation is GetOperation => operation.kind === 'get' && constants.get(operation.key.value) === key
    )
    assert.ok(get)
    return get
  }
  const callOf = (get: GetOperation): CallOperation => {
    const call = operations.find(
      (operation): operation is CallOperation => operation.kind === 'call' && operation.callee.value === get.result.id
    )
    assert.ok(call)
    return call
  }
  const self = getOf('self')
  const immediate = callOf(self)
  assert.ok(immediate.receiver && immediate.thisArgument)
  assert.equal(immediate.thisArgument.value, self.receiver.value)
  assert.notEqual(immediate.receiver.value, immediate.thisArgument.value)
  assert.equal(immediate.target?.kind, 'direct')
  const read = getOf('read')
  const borrowed = callOf(read)
  assert.ok(borrowed.thisArgument)
  assert.notEqual(borrowed.thisArgument.value, read.receiver.value)
  assert.equal(borrowed.target?.kind ?? 'unresolved', 'unresolved')
})

test('a detached native method receives strict undefined in its physical receiver lane', () => {
  const entry = resolve('test/runtime/unbound-native-method-absence-transport.runtime.ts')
  const source = `
export {}
class NativeReceiver {
  self(): this { return this }
}
const instance = new NativeReceiver()
const detached = instance.self
console.log(detached())
`
  const result = compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, source]]), includeIr: true })
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => allOperationsOf(block)))
  const detached = operations.find(
    (operation): operation is CallOperation =>
      operation.kind === 'call' && operation.receiver?.representation.kind === 'class-ref' && operation.thisArgument === undefined
  )
  assert.ok(detached)
  const entered = operations.find((operation) => operation.kind === 'convert' && operation.result.id === detached.receiver!.value)
  assert.equal(entered?.kind, 'convert')
  if (entered?.kind === 'convert') assert.equal(entered.source.representation.kind, 'undefined')
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
})

test('bind materializes the finite source suffix before adapting the published rest signature', () => {
  const entry = resolve('test/runtime/native-logical-receiver-supported-entries.runtime.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.loweringBlockers.length, 0, JSON.stringify(result.loweringBlockers))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const bound = operations.find((operation) => operation.kind === 'bind-callable' && operation.sourceAbi.receiver?.kind === 'array-object')
  assert.ok(bound && bound.kind === 'bind-callable')
  assert.equal(bound.sourceAbi.restFrom, null)
  assert.equal(bound.result.representation.kind, 'function-value-dispatch')
  if (bound.result.representation.kind === 'function-value-dispatch') assert.equal(bound.result.representation.abi.restFrom, null)
  const adapter = operations.find((operation) => operation.kind === 'convert' && operation.source.value === bound.result.id)
  assert.ok(adapter && adapter.kind === 'convert')
  assert.equal(adapter.result.representation.kind, 'function-value-dispatch')
  if (adapter.result.representation.kind === 'function-value-dispatch') assert.equal(adapter.result.representation.abi.restFrom, 0)
})
