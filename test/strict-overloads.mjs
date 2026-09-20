import assert from 'node:assert/strict'
import test from 'node:test'
import { createRepresentationDeriver } from '../dist/representation/derive.js'
import { dynamicReasons } from '../dist/representation/model.js'
import { verifyRepresentationPlan } from '../dist/representation/verify.js'

const types = new Map()
for (const primitive of ['number', 'string', 'any']) {
  types.set(primitive, { id: primitive, shape: { kind: 'primitive', primitive } })
}
const signature = (type, result = 'number') => ({
  parameters: [{ name: 'value', type, slot: type, optional: false, rest: false, hasInitializer: false }],
  minimumArity: 1,
  thisParameter: null,
  result
})
// Overloads differing ONLY in the parameter type. One stored field holds one
// frame for both calls, and the frame the implementation necessarily has is
// the union of the two parameter slots -- `derive.ts`'s `unionJoinedAbi`.
types.set('overloaded', {
  id: 'overloaded',
  shape: { kind: 'signature', call: [signature('number'), signature('string')], construct: [] }
})
// Overloads whose RESULTS disagree: no union of parameters makes one frame out
// of these, so this is the set that must still fail closed.
types.set('unjoinable', {
  id: 'unjoinable',
  shape: { kind: 'signature', call: [signature('number', 'number'), signature('string', 'string')], construct: [] }
})
const derive = (fallback, id = 'unjoinable') => createRepresentationDeriver(types, ...Array(16).fill(undefined), fallback).derive(id)

test('overloads differing only in parameter type join into one union frame', () => {
  const representation = derive(false, 'overloaded')
  assert.equal(representation.kind, 'function-value-dispatch', JSON.stringify(representation))
  const parameter = representation.abi.parameters[0]
  assert.equal(parameter.value.kind, 'tagged-union', JSON.stringify(parameter))
  assert.deepEqual(
    parameter.value.arms.map((arm) => arm.semanticType),
    ['number', 'string']
  )
  assert.equal(representation.abi.result.kind, 'scalar')
})

// A set no union of parameters joins names no calling convention, and that is
// a FACT about the value rather than a gap in the compiler: `Array.from` is
// four overloads disagreeing at parameter 0, and
// `Object.getOwnPropertyDescriptor(Array.from, 'name')` asks for no frame at
// all. So the carrier is the identity half -- the same answer
// `isIdentityOnlySignature` reaches for `(...args: never[]) => R` by the other
// route -- and it is still fail-closed: `callable-identity` states no ABI, so
// a CALL through it is refused by name at emission
// (`call-abi:no-invoke-path:callable-identity`, emit-callable.ts). What must
// NOT have happened is a new dynamic boundary being invented for the set.
test('unrepresented typed overloads carry the identity half and no calling convention', () => {
  const representation = derive(false)
  assert.equal(representation.kind, 'callable-identity', JSON.stringify(representation))
  assert.equal('abi' in representation, false, JSON.stringify(representation))
  assert.deepEqual(verifyRepresentationPlan({ selected: new Map([['overload', representation]]), conflicts: [] }), [])
  assert.equal(dynamicReasons.includes('unjoinable-declared-overload-set'), false)
})

test('overload boxing requires explicit dynamic fallback and is counted as fallback', () => {
  assert.deepEqual(derive(true), { kind: 'dynamic', reason: 'opt-in-fallback' })
})

test('an explicitly dynamic source type remains a legitimate boundary', () => {
  assert.deepEqual(createRepresentationDeriver(types).derive('any'), { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
})
