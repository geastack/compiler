import { irValueId, type IrValueId, type PhysicalBodyId } from '../identity/ids.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { IrBlock, IrBlockId, IrBody, IrOperand, IrOperation, IrPhiIncoming, TestOperation } from './model.js'
import { allOperationsOf } from './model.js'
import { operandsOfIrOperation, successorsOfTerminator } from './queries.js'
import { verifyIrBody } from './verify.js'

/**
 * Thread the edge of a short-circuit join whose value the edge already decides.
 *
 * `while (i < max && zr * zr + zi * zi <= 4)` lowers to a join that only
 * re-tests what got there: the `&&` merges `i < max` (on the edge where it was
 * false) with the right operand, and the loop branches on the merge. On that
 * edge the merged value IS the condition that chose the edge, so its branch
 * is decided, and the edge can go straight to the branch's false arm. Without
 * this the C++ is a materialized `bool` written on both arms and tested again
 * -- the same instructions, but laid out so clang 18 and 22 schedule the loop
 * 1.5% slower than the `&&` it came from (an escape-time loop), and
 * neither unrolls it when the bound is a constant.
 *
 * Operands of different types merge into a wider carrier, so each edge first
 * widens its own value: `if (engaged && player)` stores `engaged` or `player`
 * into an `Optional<TaggedUnion<bool, Ref<Player>>>` -- a retain, an
 * out-of-line assignment and an arm dispatch -- only to ask whether it is
 * truthy. A widening into an arm keeps the value, so it keeps its truthiness:
 * the decided edge threads past it, and the other edge tests its own value and
 * branches, leaving the merge unbuilt.
 *
 * Only the exact shape: a join holding one phi (and at most a `to-boolean`
 * test of it) and nothing else, branching on it, read by nothing else; an
 * edge from the deciding branch, directly or through a block holding only a
 * jump (or only that widening). The threaded target must have no phi of its
 * own, since the new edge would owe it an incoming value. Anything else is
 * left as it was, and a body the rewrite would leave invalid is kept unchanged.
 */
export const threadShortCircuitJoins = (bodies: ReadonlyMap<PhysicalBodyId, IrBody>): ReadonlyMap<PhysicalBodyId, IrBody> => {
  let output: Map<PhysicalBodyId, IrBody> | null = null
  for (const [id, body] of bodies) {
    const threaded = threadedBody(body)
    if (threaded === body) continue
    output ??= new Map(bodies)
    output.set(id, threaded)
  }
  return output ?? bodies
}

/** Carriers `ir/certify/runtime-helper.ts` admits a `to-boolean` test over (`manifest/capabilities.ts`). */
const testableKinds: ReadonlySet<Representation['kind']> = new Set<Representation['kind']>([
  'scalar',
  'string',
  'optional',
  'tagged-union',
  'class-ref',
  'record',
  'record-with-index',
  'native-record-ref'
])

const armsOf = (representation: Representation): readonly Representation[] =>
  representation.kind === 'optional'
    ? armsOf(representation.payload)
    : representation.kind === 'tagged-union'
      ? representation.arms.flatMap((arm) => armsOf(arm.value))
      : [representation]

/** Every arm of `source` is an arm of `target`: the conversion places the value, and absence stays absence. */
const widensIntoArm = (source: Representation, target: Representation): boolean => {
  if (target.kind !== 'optional' && target.kind !== 'tagged-union') return false
  if (source.kind === 'optional' && target.kind !== 'optional') return false
  const targetArms = new Set(armsOf(target).map(representationKey))
  return armsOf(source).every((arm) => targetArms.has(representationKey(arm)))
}

type Thread =
  | { readonly kind: 'retarget'; readonly via: IrBlock; readonly target: IrBlockId; readonly edge: IrPhiIncoming; readonly strips: boolean }
  | { readonly kind: 'test'; readonly via: IrBlock; readonly source: IrOperand; readonly edge: IrPhiIncoming; readonly strips: true }

const threadedBody = (body: IrBody): IrBody => {
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0 || body.generator || body.generatorPrologueBoundary)
    return body
  const uses = new Map<IrValueId, number>()
  const definitions = new Map<IrValueId, IrOperation>()
  const predecessors = new Map<IrBlockId, IrBlockId[]>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if ('result' in operation && operation.result) definitions.set(operation.result.id, operation)
      for (const operand of operandsOfIrOperation(operation)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
    }
    for (const target of successorsOfTerminator(block.terminator)) {
      const list = predecessors.get(target) ?? []
      list.push(block.id)
      predecessors.set(target, list)
    }
  }
  // A block other facts name by id stays: removing it would leave them pointing nowhere.
  const pinned = new Set<string>([body.entry, ...(body.bindingLifetimeOrigins?.values() ?? [])])
  const loopPlan = body.denseLoopPlan === undefined ? '' : JSON.stringify(body.denseLoopPlan)
  // The truthiness `value` is known to have along the edge out of `from`, when
  // `from` branches on it (or on its `to-boolean` test) and the edge is one arm.
  const decided = (from: IrBlock, toward: IrBlockId, value: IrOperand): boolean | undefined => {
    const terminator = from.terminator
    if (terminator.kind !== 'branch' || terminator.whenTrue === terminator.whenFalse) return undefined
    const condition = terminator.condition.value
    const tested = definitions.get(condition)
    const same =
      condition === value.value || (tested?.kind === 'test' && tested.predicate === 'to-boolean' && tested.value.value === value.value)
    if (!same) return undefined
    return toward === terminator.whenTrue
  }
  // The value an edge widened into the merge's carrier as its block's last
  // step, when nothing else reads the widened copy.
  const widenedSource = (via: IrBlock, edge: IrPhiIncoming, join: IrBlockId): IrOperand | null => {
    if (via.terminator.kind !== 'jump' || via.terminator.target !== join) return null
    const last = via.operations[via.operations.length - 1]
    if (last?.kind !== 'convert' || last.result.id !== edge.value.value || uses.get(last.result.id) !== 1) return null
    if (last.rebuild !== undefined || last.presence !== undefined) return null
    return widensIntoArm(last.source.representation, last.result.representation) ? last.source : null
  }
  const blocks = new Map(body.blocks)
  const values = new Map(body.values)
  const removed = new Set<IrBlockId>()
  let ordinal = 0
  const freshValue = (representation: Representation): IrValueId => {
    while (values.has(irValueId(body.owner, ordinal))) ordinal++
    const id = irValueId(body.owner, ordinal++)
    values.set(id, representation)
    return id
  }
  let changed = false
  for (const join of body.blocks.values()) {
    const [phi, test, ...rest] = join.operations
    if (phi?.kind !== 'phi' || rest.length > 0 || join.terminator.kind !== 'branch') continue
    const branchOn = join.terminator.condition.value
    if (test !== undefined && (test.kind !== 'test' || test.predicate !== 'to-boolean' || test.value.value !== phi.result.id)) continue
    const tested = test?.kind === 'test' ? test.result.id : phi.result.id
    if (branchOn !== tested || uses.get(tested) !== 1 || (test !== undefined && uses.get(phi.result.id) !== 1)) continue
    const { whenTrue, whenFalse } = join.terminator
    const phiFree = (target: IrBlockId): boolean => blocks.get(target)?.operations.some((operation) => operation.kind === 'phi') === false
    const threads: Thread[] = []
    for (const edge of phi.incoming) {
      const via = blocks.get(edge.block)
      if (via === undefined) continue
      const widened = widenedSource(via, edge, join.id)
      if (widened !== null) {
        const stripped = { ...via, operations: via.operations.slice(0, -1) }
        const only = predecessors.get(via.id)
        const from = only?.length === 1 && stripped.operations.length === 0 ? blocks.get(only[0]!) : undefined
        const truth = from === undefined ? undefined : decided(from, via.id, widened)
        if (truth !== undefined) {
          const target = truth ? whenTrue : whenFalse
          if (phiFree(target)) threads.push({ kind: 'retarget', via: stripped, target, edge, strips: true })
        } else if (test?.kind === 'test' && testableKinds.has(widened.representation.kind) && phiFree(whenTrue) && phiFree(whenFalse)) {
          threads.push({ kind: 'test', via: stripped, source: widened, edge, strips: true })
        }
        continue
      }
      // Directly from the deciding branch, or through a block that only jumps here.
      let decider = via
      let edgeTarget = join.id
      if (via.terminator.kind === 'jump' && via.operations.length === 0) {
        const only = predecessors.get(via.id)
        const from = only?.length === 1 ? blocks.get(only[0]!) : undefined
        if (from === undefined) continue
        decider = from
        edgeTarget = via.id
      }
      const truth = decided(decider, edgeTarget, edge.value)
      if (truth === undefined) continue
      const target = truth ? whenTrue : whenFalse
      if (!phiFree(target)) continue
      threads.push({ kind: 'retarget', via, target, edge, strips: false })
    }
    const everyEdge = threads.length === phi.incoming.length
    // A join every edge threads past by retargeting alone is the whole
    // expression decided by its left operand, which is not this shape; leave
    // it for the C++ compiler. One whose remaining edges each test their own
    // value is left with no predecessor, and goes.
    if (threads.length === 0 || (everyEdge && threads.every((thread) => thread.kind === 'retarget'))) continue
    if (everyEdge && (pinned.has(join.id) || loopPlan.includes(JSON.stringify(join.id)))) continue
    if (!everyEdge && threads.some((thread) => thread.kind === 'test')) continue
    for (const thread of threads) {
      // The widening the edge no longer performs.
      if (thread.strips) values.delete(thread.edge.value.value)
      if (thread.kind === 'retarget') {
        blocks.set(thread.via.id, retarget(thread.via, join.id, thread.target))
        continue
      }
      const joinTest = test as TestOperation
      const result = { id: freshValue(joinTest.result.representation), representation: joinTest.result.representation }
      const own: TestOperation = { kind: 'test', lineage: joinTest.lineage, predicate: 'to-boolean', value: thread.source, result }
      blocks.set(thread.via.id, {
        ...thread.via,
        operations: [...thread.via.operations, own],
        terminator: { ...join.terminator, condition: { value: result.id, representation: result.representation } }
      })
    }
    changed = true
    if (everyEdge) {
      blocks.delete(join.id)
      removed.add(join.id)
      values.delete(phi.result.id)
      if (test !== undefined) values.delete(tested)
      continue
    }
    const incoming = phi.incoming.filter((edge) => !threads.some((thread) => thread.edge === edge))
    blocks.set(join.id, { ...blocks.get(join.id)!, operations: [{ ...phi, incoming }, ...(test === undefined ? [] : [test])] })
  }
  if (!changed) return body
  const rewritten: IrBody = {
    ...body,
    blocks,
    values,
    blockOrder: removed.size === 0 ? body.blockOrder : body.blockOrder.filter((block) => !removed.has(block))
  }
  return verifyIrBody(rewritten).length === 0 ? rewritten : body
}

const retarget = (block: IrBlock, from: IrBlockId, to: IrBlockId): IrBlock => {
  const terminator = block.terminator
  if (terminator.kind === 'jump') return { ...block, terminator: { ...terminator, target: to } }
  if (terminator.kind !== 'branch') return block
  return {
    ...block,
    terminator: {
      ...terminator,
      whenTrue: terminator.whenTrue === from ? to : terminator.whenTrue,
      whenFalse: terminator.whenFalse === from ? to : terminator.whenFalse
    }
  }
}
