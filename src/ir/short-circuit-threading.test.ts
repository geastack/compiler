import assert from 'node:assert/strict'
import test from 'node:test'
import type { FunctionId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { createIrBodyBuilder } from './build.js'
import { threadShortCircuitJoins } from './short-circuit-threading.js'
import { verifyIrBody } from './verify.js'

const owner = 'short-circuit-owner' as FunctionId
const physical = 'short-circuit-body' as PhysicalBodyId
const lineage = 'short-circuit-lineage' as SemanticResultId
const number: Representation = { kind: 'scalar', domain: 'number' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }

// `if (a < b && b < c) return 1; return 0`, lowered the way `&&` lowers: the
// join merges the left operand on its false edge with the right operand.
const conjunction = (options: { readonly mergedEscapes?: boolean; readonly throughBlock?: boolean } = {}) => {
  const builder = createIrBodyBuilder(physical, owner, null)
  const entry = builder.openBlock()
  const right = builder.openBlock()
  const skipped = options.throughBlock === false ? null : builder.openBlock()
  const join = builder.openBlock()
  const taken = builder.openBlock()
  const exit = builder.openBlock()
  const a = builder.constant(entry, lineage, '1', 'number', number)
  const b = builder.constant(entry, lineage, '2', 'number', number)
  const c = builder.constant(entry, lineage, '3', 'number', number)
  const left = builder.compute(
    entry,
    lineage,
    'binary',
    '<',
    [
      { value: a, representation: number },
      { value: b, representation: number }
    ],
    boolean
  )
  builder.branch(entry, lineage, { value: left, representation: boolean }, right, skipped ?? join)
  const second = builder.compute(
    right,
    lineage,
    'binary',
    '<',
    [
      { value: b, representation: number },
      { value: c, representation: number }
    ],
    boolean
  )
  builder.jump(right, null, join)
  if (skipped !== null) builder.jump(skipped, null, join)
  const merged = builder.phi(
    join,
    lineage,
    [
      { block: right, value: { value: second, representation: boolean } },
      { block: skipped ?? entry, value: { value: left, representation: boolean } }
    ],
    boolean
  )
  builder.branch(join, lineage, { value: merged, representation: boolean }, taken, exit)
  const one = builder.constant(taken, lineage, '1', 'number', number)
  builder.return(taken, null, { value: one, representation: number })
  if (options.mergedEscapes) builder.return(exit, null, { value: merged, representation: boolean })
  else builder.return(exit, null, { value: builder.constant(exit, lineage, '0', 'number', number), representation: number })
  return { body: builder.seal(), entry, right, skipped, join, exit }
}

test("the left operand's false edge goes straight to the join's false arm", () => {
  const { body, skipped, join, right, exit } = conjunction()
  const threaded = threadShortCircuitJoins(new Map([[physical, body]])).get(physical)!
  assert.notEqual(threaded, body)
  assert.deepEqual(threaded.blocks.get(skipped!)!.terminator, { kind: 'jump', lineage: null, target: exit })
  const phi = threaded.blocks.get(join)!.operations[0]!
  assert.equal(phi.kind, 'phi')
  if (phi.kind === 'phi')
    assert.deepEqual(
      phi.incoming.map((edge) => edge.block),
      [right]
    )
  assert.deepEqual(verifyIrBody(threaded), [])
})

test('a direct edge from the deciding branch is threaded too', () => {
  const { body, entry, exit } = conjunction({ throughBlock: false })
  const threaded = threadShortCircuitJoins(new Map([[physical, body]])).get(physical)!
  const terminator = threaded.blocks.get(entry)!.terminator
  assert.equal(terminator.kind, 'branch')
  if (terminator.kind === 'branch') assert.equal(terminator.whenFalse, exit)
  assert.deepEqual(verifyIrBody(threaded), [])
})

test('a merged value something else reads keeps its join', () => {
  const { body } = conjunction({ mergedEscapes: true })
  const bodies = new Map([[physical, body]])
  assert.equal(threadShortCircuitJoins(bodies), bodies)
})
