import type { IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { IrBlock, IrBlockId, IrBody, IrOperand, IrOperation } from './model.js'
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
 * Only the exact shape: a join holding one phi (and at most a `to-boolean`
 * test of it) and nothing else, branching on it, read by nothing else; an
 * edge from the deciding branch, directly or through a block holding only a
 * jump. The threaded target must have no phi of its own, since the new edge
 * would owe it an incoming value. Anything else is left as it was, and a body
 * the rewrite would leave invalid is kept unchanged.
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
  const blocks = new Map(body.blocks)
  let changed = false
  for (const join of body.blocks.values()) {
    const [phi, test, ...rest] = join.operations
    if (phi?.kind !== 'phi' || rest.length > 0 || join.terminator.kind !== 'branch') continue
    const branchOn = join.terminator.condition.value
    if (test !== undefined && (test.kind !== 'test' || test.predicate !== 'to-boolean' || test.value.value !== phi.result.id)) continue
    const tested = test?.kind === 'test' ? test.result.id : phi.result.id
    if (branchOn !== tested || uses.get(tested) !== 1 || (test !== undefined && uses.get(phi.result.id) !== 1)) continue
    const { whenTrue, whenFalse } = join.terminator
    const threads: { readonly via: IrBlock; readonly target: IrBlockId; readonly edge: (typeof phi.incoming)[number] }[] = []
    for (const edge of phi.incoming) {
      const via = blocks.get(edge.block)
      if (via === undefined) continue
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
      if (blocks.get(target)?.operations.some((operation) => operation.kind === 'phi') !== false) continue
      threads.push({ via, target, edge })
    }
    // A join every edge threads past is the whole expression decided by its
    // left operand, which is not this shape; leave it for the C++ compiler.
    if (threads.length === 0 || threads.length === phi.incoming.length) continue
    for (const { via, target } of threads) blocks.set(via.id, retarget(via, join.id, target))
    const incoming = phi.incoming.filter((edge) => !threads.some((thread) => thread.edge === edge))
    changed = true
    blocks.set(join.id, { ...blocks.get(join.id)!, operations: [{ ...phi, incoming }, ...(test === undefined ? [] : [test])] })
  }
  if (!changed) return body
  const rewritten = { ...body, blocks }
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
