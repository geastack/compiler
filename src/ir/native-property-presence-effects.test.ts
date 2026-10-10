import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { Representation } from '../representation/model.js'
import { normalCompletion, pureEffects } from '../semantics/model/operands.js'
import type { AllocationOperation, SemanticOperation } from '../semantics/model/operations.js'
import { createIrBodyBuilder } from './build.js'
import { allOperationsOf, type GetOperation, type SetOperation } from './model.js'
import { nativePropertyPresenceAuthorityOf } from './native-property-presence.js'
import { nativeOrdinaryAllocationMatches, nativeOrdinaryPropertyPreservesPresence } from './native-property-presence-effects.js'

const string: Representation = { kind: 'string' }
const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
const otherKey = '__gea_presence_optional_other__'
const record: Representation = {
  kind: 'record',
  shapeId: 'presence-ordinary',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [
    { key: '$type', value: string, required: true },
    { key: otherKey, value: optional, required: false }
  ]
}

const guardedRead = (kind: 'get' | 'set', proof: boolean) => {
  const builder = createIrBodyBuilder('presence-effects-body' as never, 'presence-effects-owner' as never, null)
  const entry = builder.openBlock()
  const selected = builder.openBlock()
  const other = builder.openBlock()
  const lineage = 'presence-effects' as never
  const receiver = { value: builder.allocateRecord(entry, lineage, [], record, true), representation: record }
  const key = { value: builder.constant(entry, lineage, '$type', 'string', string), representation: string }
  const optionalKey = { value: builder.constant(entry, lineage, otherKey, 'string', string), representation: string }
  const assigned = { value: builder.constant(entry, lineage, 'write', 'string', string), representation: string }
  const condition = builder.hasProperty(entry, lineage, receiver, key, { kind: 'scalar', domain: 'boolean' }, true)
  builder.branch(entry, lineage, { value: condition, representation: { kind: 'scalar', domain: 'boolean' } }, selected, other)
  const operation: GetOperation | SetOperation =
    kind === 'get'
      ? {
          kind,
          lineage,
          receiver,
          key: optionalKey,
          result: { id: 'optional-read' as never, representation: optional },
          ...(proof ? { ordinaryObjectPrototypeKeyAbsent: true as const } : {})
        }
      : {
          kind,
          lineage,
          receiver,
          key: optionalKey,
          value: assigned,
          strict: true,
          result: null,
          ...(proof ? { ordinaryObjectDataWriteAbsent: true as const } : {})
        }
  const answer = builder.get(selected, lineage, receiver, key, string)
  builder.return(selected, lineage, { value: answer, representation: string })
  builder.return(other, lineage, null)
  const original = builder.seal()
  const body = {
    ...original,
    blocks: new Map(
      [...original.blocks].map(([id, block]) => [id, id === selected ? { ...block, operations: [operation, ...block.operations] } : block])
    )
  }
  const read = [...body.blocks.values()].flatMap(allOperationsOf).find((op) => op.kind === 'get' && op.key.value === key.value)!
  const authority = nativePropertyPresenceAuthorityOf(body, { nodeById: () => null })
  return authority(
    receiver,
    '$type',
    read,
    (effect, guard) => (effect.kind === 'get' || effect.kind === 'set') && nativeOrdinaryPropertyPreservesPresence(effect, otherKey, guard)
  )
}

test('an inherited interceptor at an absent optional different key revokes the earlier Has guard', () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, otherKey)
  try {
    Object.defineProperty(Object.prototype, otherKey, {
      configurable: true,
      get(this: Record<string, string>) {
        delete this.$type
        return 'inherited'
      },
      set(this: Record<string, string>, _value: string) {
        delete this.$type
      }
    })
    for (const kind of ['get', 'set'] as const) {
      const actual: Record<string, string> = { $type: 'present' }
      assert.equal('$type' in actual, true)
      if (kind === 'get') void actual[otherKey]
      else actual[otherKey] = 'write'
      assert.equal('$type' in actual, false, `the inherited ${kind} executes despite a physical optional slot`)
      assert.equal(guardedRead(kind, false), null)
    }
  } finally {
    if (previous) Object.defineProperty(Object.prototype, otherKey, previous)
    else Reflect.deleteProperty(Object.prototype, otherKey)
  }
})

test('the exact different-key prototype absence protocol preserves Get and Set guards', () => {
  for (const kind of ['get', 'set'] as const) assert.equal(guardedRead(kind, true)?.present, true)
})

test('ordinary allocation provenance cannot be borrowed by a tuple, constructor, or another result', () => {
  const lineage = 'ordinary-allocation' as never
  const operation = {
    kind: 'allocate-record' as const,
    lineage,
    fields: [],
    result: { id: 'ordinary-value' as never, representation: record },
    ordinaryObjectPrototype: true as const
  }
  const semantic: SemanticOperation = {
    id: 'ordinary-operation' as never,
    caller: { kind: 'region', regionId: 'ordinary-region' as never },
    family: 'allocation',
    allocated: 'object-literal',
    ordinaryObjectPrototype: true,
    shape: 'ordinary-shape' as never,
    callable: null,
    operands: [],
    results: [{ id: lineage, role: 'value', type: 'ordinary-shape' as never }],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: 0
  }
  assert.equal(nativeOrdinaryAllocationMatches(operation, semantic), true)
  assert.equal(nativeOrdinaryAllocationMatches(operation, { ...semantic, allocated: 'array-literal' }), false)
  assert.equal(nativeOrdinaryAllocationMatches(operation, { ...semantic, allocated: 'construction-result' }), false)
  const { ordinaryObjectPrototype: _proof, ...unproved } = semantic
  assert.equal(_proof, true)
  assert.equal(nativeOrdinaryAllocationMatches(operation, unproved), false)
  assert.equal(nativeOrdinaryAllocationMatches({ ...operation, lineage: 'other' as never }, semantic), false)
})

test('source allocation facts distinguish colon prototype initializers from own data keys and tuple arrays', () => {
  const entry = resolve('test/fixtures/ordinary-allocation-prototype.ts')
  const compiled = compile({
    rootFileNames: [entry],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        entry,
        `export {};
      const plain = { own: 1 };
      const colon = { __proto__: null, own: 2 };
      const computed = { ['__proto__']: null, own: 3 };
      const tuple: [number, string] = [4, 'five'];
      console.log(plain.own, colon.own, computed.own, tuple[0], tuple[1], tuple);`
      ]
    ]),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
  const literals = [...compiled.graph.operations.values()].filter(
    (operation): operation is AllocationOperation => operation.family === 'allocation' && operation.allocated === 'object-literal'
  )
  assert.deepEqual(
    literals.map((operation) => operation.ordinaryObjectPrototype === true),
    [true, false, true]
  )
  const tuples = (compiled.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .filter((operation) => {
      if (operation.kind !== 'allocate-record') return false
      return [...compiled.graph.operations.values()].some(
        (source) =>
          source.family === 'allocation' &&
          source.allocated === 'array-literal' &&
          source.results.some((result) => result.id === operation.lineage)
      )
    })
  assert.ok(tuples.length > 0, 'the regression exercises an array lowered through a physical record')
  for (const tuple of tuples) {
    assert.ok(tuple.kind === 'allocate-record')
    assert.notEqual(tuple.ordinaryObjectPrototype, true)
  }
})
