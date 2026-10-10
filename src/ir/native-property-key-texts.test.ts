import assert from 'node:assert/strict'
import { compile } from '../compiler.js'
import { resolve } from 'node:path'
import { allOperationsOf } from './model.js'
import test from 'node:test'
import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { Representation } from '../representation/model.js'
import type { IrOperation } from './model.js'
import { nativePropertyKeyTextsOf } from './native-property-key-texts.js'

const declaration = 'installed-string' as DeclarationId
const string: Representation = { kind: 'string' }
const native: Representation = {
  kind: 'native-handle',
  protocol: 'StringConstructor',
  native: null,
  version: 1,
  bases: [],
  call: null,
  construct: null
}
const key = { value: 'key' as IrValueId, representation: string }
const definition = (id: string, text: string, literal: 'string' | 'number'): IrOperation => ({
  kind: 'constant',
  lineage: `literal-${id}` as never,
  literal,
  text,
  result: { id: id as IrValueId, representation: literal === 'string' ? string : { kind: 'scalar', domain: 'number' } }
})
const read: IrOperation = {
  kind: 'binding-read',
  lineage: 'read-string' as never,
  declaration,
  result: { id: 'callee' as IrValueId, representation: native }
}
const call: IrOperation = {
  kind: 'call',
  lineage: 'string-call' as never,
  callee: { value: 'callee' as IrValueId, representation: native },
  receiver: null,
  arguments: [{ value: 'input' as IrValueId, representation: string }],
  result: { id: key.value, representation: string }
}
const placements = new Map<DeclarationId, BindingPlacement>([
  [declaration, { storage: { kind: 'host-class', linkageName: 'String' }, representation: native }]
])

test('an installed String constructor retains the finite primitive key domain', () => {
  assert.deepEqual(nativePropertyKeyTextsOf(key, [read, definition('input', 'm', 'string'), call], placements), ['m'])
  assert.deepEqual(nativePropertyKeyTextsOf(key, [read, definition('input', '1e1', 'number'), call], placements), ['10'])
  assert.deepEqual(nativePropertyKeyTextsOf({ ...key, value: 'input' as IrValueId }, [definition('input', '0x10', 'number')], placements), [
    '16'
  ])
})

test('equal callable spelling does not replace installed source identity or a known primitive argument', () => {
  assert.equal(nativePropertyKeyTextsOf(key, [read, definition('input', 'm', 'string'), call], new Map()), null)
  assert.equal(nativePropertyKeyTextsOf(key, [read, call], placements), null)
  const local = new Map<DeclarationId, BindingPlacement>([
    [declaration, { storage: { kind: 'local', owner: 'local' as never }, representation: native }]
  ])
  assert.equal(nativePropertyKeyTextsOf(key, [read, definition('input', 'm', 'string'), call], local), null)
})

test('a write to the installed constructor prevents a constant builtin interpretation', () => {
  const write: IrOperation = {
    kind: 'binding-write',
    lineage: 'changed' as never,
    declaration,
    value: { value: 'callee' as IrValueId, representation: native }
  }
  assert.equal(nativePropertyKeyTextsOf(key, [read, definition('input', 'm', 'string'), write, call], placements), null)
})

test('a real String-shadowed parameter cannot borrow the installed constructor key proof', () => {
  const entry = resolve('test/runtime/shadowed-string-key-proof.ts')
  const source = `export {}
class C { static m(): number { return 7 }; static n(): number { return 9 } }
function invoke(String: (input: string) => 'm' | 'n'): number { return C[String('m')]() }
console.log(invoke(() => 'n'))`
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, source]])
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.loweringBlockers.length, 0, JSON.stringify(result.loweringBlockers))
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const definitions = new Map(
    operations.flatMap((operation) => ('result' in operation && operation.result ? [[operation.result.id, operation] as const] : []))
  )
  const reads = operations.filter(
    (operation) =>
      operation.kind === 'get' &&
      operation.receiver.representation.kind === 'constructor-family' &&
      definitions.get(operation.key.value)?.kind === 'call'
  )
  assert.equal(reads.length, 1)
  for (const read of reads)
    if (read.kind === 'get') assert.equal(nativePropertyKeyTextsOf(read.key, operations, result.projection.placements), null)
})
