import assert from 'node:assert/strict'
import test from 'node:test'
import type { FunctionId, OperationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { declarationId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { AllocationOperation } from '../semantics/model/operations.js'
import { normalCompletion, pureEffects } from '../semantics/model/operands.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'
import type { SignatureShape, StructuralType } from '../semantics/model/structural-types.js'
import { createRepresentationDeriver } from './derive.js'
import { abiKey, type Representation } from './model.js'
import { publishRepresentations } from './publish.js'
import { publicStructuralMethodAbiOf } from './structural-method-abi.js'

const fixture = () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const receiver = table.intern({
    kind: 'object',
    members: [{ key: { kind: 'string', value: 'name' }, type: string, optional: false, readonly: false, accessor: null }],
    index: [],
    membersDropped: false
  })
  const signature: SignatureShape = {
    parameters: [{ type: string, slot: string, optional: false, rest: false, hasInitializer: false }],
    minimumArity: 1,
    thisParameter: receiver,
    implicitReceiver: true,
    result: string
  }
  const implicit = table.intern({ kind: 'signature', call: [signature], construct: [] })
  const explicitSignature = {
    parameters: signature.parameters,
    minimumArity: signature.minimumArity,
    thisParameter: signature.thisParameter,
    result: signature.result
  }
  const explicit = table.intern({ kind: 'signature', call: [explicitSignature], construct: [] })
  return { types: table.seal(), implicit, explicit, signature }
}

const allocation = (shape: StructuralTypeId, callable: FunctionId, name = 'allocation'): AllocationOperation => ({
  id: name as OperationId,
  family: 'allocation',
  caller: { kind: 'region', regionId: 'module' as never },
  allocated: 'function-object',
  shape,
  callable,
  operands: [],
  results: [{ id: `${name}-result` as SemanticResultId, role: 'value', type: shape }],
  completion: normalCompletion,
  effects: { ...pureEffects, allocates: true },
  evaluationOrdinal: 0
})

const graphOf = (types: ReadonlyMap<StructuralTypeId, StructuralType>, ...operations: AllocationOperation[]): SemanticGraph => ({
  regions: new Map(),
  structuralTypes: types,
  operations: new Map(operations.map((operation) => [operation.id, operation])),
  edges: [],
  coverage: new Map(),
  results: new Map(operations.flatMap((operation) => operation.results.map((result) => [result.id, operation.id])))
})

test('an implicit structural method exposes a nil public receiver and retains its exact physical allocation frame', () => {
  const { types, implicit, signature } = fixture()
  const callable = 'structural-source-method' as FunctionId
  const operation = allocation(implicit, callable)
  const published = publishRepresentations(graphOf(types, operation))
  const publicValue = published.deriver.derive(implicit)
  const physicalValue = published.plan.selected.get(operation.results[0]!.id)
  assert.equal(publicValue.kind, 'function-value-dispatch')
  assert.equal(publicValue.abi.receiver, null)
  assert.equal(physicalValue?.kind, 'function-value-dispatch')
  assert.equal(physicalValue.abi.receiver?.kind, 'record')
  assert.equal(abiKey(physicalValue.abi), abiKey(published.deriver.abiOf(signature)!))
  assert.equal(abiKey({ ...physicalValue.abi, receiver: null }), abiKey(publicValue.abi))
  assert.deepEqual(published.violations, [])
  assert.equal(published.deriver.nativeCallableConventions('unknown-source' as FunctionId), null)
})

test('an explicit structural this and mixed implicit/explicit signatures retain their public receiver', () => {
  const { types, explicit, signature } = fixture()
  const deriver = createRepresentationDeriver(types)
  const value = deriver.derive(explicit)
  assert.equal(value.kind, 'function-value-dispatch')
  assert.equal(value.abi.receiver?.kind, 'record')
  const written = {
    parameters: signature.parameters,
    minimumArity: signature.minimumArity,
    thisParameter: signature.thisParameter,
    result: signature.result
  }
  assert.strictEqual(publicStructuralMethodAbiOf([signature, written], value.abi), value.abi)
})

test('implicit class receivers and native foreign records retain their physical public convention', () => {
  const { types, signature } = fixture()
  const abi = createRepresentationDeriver(types).abiOf(signature)!
  const receiver: Representation = {
    kind: 'class-ref',
    declaration: declarationId('nominal-method-receiver', 0),
    shapeId: 'nominal-method-receiver',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  for (const physical of [
    { ...abi, receiver },
    {
      ...abi,
      receiver: { kind: 'native-record-ref', shapeId: 'foreign', ownership: 'shared-refcount', native: 'foreign::Receiver' } as const
    }
  ])
    assert.strictEqual(publicStructuralMethodAbiOf([signature], physical), physical)
})

test('conflicting semantic allocations cannot grant one Function identity a physical receiver frame', () => {
  const { types, implicit, explicit } = fixture()
  const callable = 'conflicting-source' as FunctionId
  const first = allocation(implicit, callable, 'first')
  const second = allocation(explicit, callable, 'second')
  const published = publishRepresentations(graphOf(types, first, second))
  assert.equal(published.deriver.nativeCallableConventions(callable), null)
  const firstValue = published.plan.selected.get(first.results[0]!.id)
  assert.equal(firstValue?.kind, 'function-value-dispatch')
  assert.equal(firstValue.abi.receiver, null)
})
