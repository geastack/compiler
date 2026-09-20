import type { IrValueId } from '../identity/ids.js'
import { type IrBlockId, type IrBody } from './model.js'
import { resultOfIrOperation, successorsOfTerminator } from './queries.js'

/**
 * Control-flow reachability and dominance over one IR body.
 *
 * `verify.ts` needs both to decide whether a use is legal: an operand may
 * reference a value defined earlier in the same block, or defined in any
 * block that *dominates* the block containing the use. Without dominance, a
 * verifier can only accept straight-line code and must either reject every
 * loop-carried value or accept some genuinely unsound programs; this module
 * exists so the IR can represent loops without weakening the "used before
 * defined" guard.
 *
 * The algorithm is Cooper/Harvey/Kennedy's iterative dominance computation --
 * simple, and fast enough for the block counts one physical body has. Blocks
 * unreachable from the entry never receive a dominator; every query about
 * them fails closed to "not proven" rather than guessing.
 */

export interface ControlFlowGraph {
  readonly successors: ReadonlyMap<IrBlockId, readonly IrBlockId[]>
  readonly predecessors: ReadonlyMap<IrBlockId, readonly IrBlockId[]>
}

/** The single authority for CFG edges. Both the phi/predecessor guard and the dominator tree read this, never a second computation. */
export const buildControlFlowGraph = (body: IrBody): ControlFlowGraph => {
  const successors = new Map<IrBlockId, IrBlockId[]>()
  const predecessors = new Map<IrBlockId, IrBlockId[]>()
  for (const id of body.blockOrder) {
    successors.set(id, [])
    predecessors.set(id, [])
  }
  for (const id of body.blockOrder) {
    const block = body.blocks.get(id)
    if (!block) continue
    const targets = successorsOfTerminator(block.terminator)
    successors.set(id, [...targets])
    for (const target of targets) predecessors.get(target)?.push(id)
  }
  return { successors, predecessors }
}

export interface DominatorTree {
  /** Whether `ancestor` dominates `block` (every path from entry to `block` passes through `ancestor`). A block dominates itself. */
  readonly dominates: (ancestor: IrBlockId, block: IrBlockId) => boolean
  /** Blocks reachable from entry, in reverse-postorder. Unreachable blocks are never listed here. */
  readonly reachable: ReadonlySet<IrBlockId>
}

const reversePostorder = (entry: IrBlockId, successors: ReadonlyMap<IrBlockId, readonly IrBlockId[]>): readonly IrBlockId[] => {
  const visited = new Set<IrBlockId>()
  const postorder: IrBlockId[] = []
  const stack: { readonly block: IrBlockId; readonly childIndex: number }[] = [{ block: entry, childIndex: 0 }]
  visited.add(entry)
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (!frame) break
    const children = successors.get(frame.block) ?? []
    if (frame.childIndex >= children.length) {
      postorder.push(frame.block)
      stack.pop()
      continue
    }
    const child = children[frame.childIndex]
    stack[stack.length - 1] = { block: frame.block, childIndex: frame.childIndex + 1 }
    if (child !== undefined && !visited.has(child)) {
      visited.add(child)
      stack.push({ block: child, childIndex: 0 })
    }
  }
  return postorder.reverse()
}

/**
 * The cached control flow of one body -- `IrBody.dominance`, a fact moved out of the target. A sealed body's CFG, dominator tree and
 * cyclic-block set are facts of the body, and every analysis that asked for
 * them rebuilt them from scratch (seven sites under `targets/cpp`, five under
 * `ir/`). Memoised by body identity rather than stored as a field so that a
 * body nothing analyses pays nothing, and so `generator-split.ts`, which
 * mints new bodies, invalidates by construction. `verify.ts` deliberately
 * builds its own: it is the check on the body, and must not read a fact
 * computed from the structure it is about to reject.
 */
const controlFlowGraphs = new WeakMap<IrBody, ControlFlowGraph>()
const dominatorTrees = new WeakMap<IrBody, DominatorTree>()
const cyclicBlockSets = new WeakMap<IrBody, ReadonlySet<IrBlockId>>()

export const controlFlowGraphOf = (body: IrBody): ControlFlowGraph => {
  const cached = controlFlowGraphs.get(body)
  if (cached) return cached
  const graph = buildControlFlowGraph(body)
  controlFlowGraphs.set(body, graph)
  return graph
}

export const dominatorTreeOf = (body: IrBody): DominatorTree => {
  const cached = dominatorTrees.get(body)
  if (cached) return cached
  const dominance = buildDominatorTree(body, controlFlowGraphOf(body))
  dominatorTrees.set(body, dominance)
  return dominance
}

/**
 * The blocks that lie on some cycle: a block that can reach itself.
 *
 * A reachability closure over the successor graph. Reducibility is not assumed:
 * the closure asks only whether some path from a block returns to it, so it
 * cannot be wrong about an irreducible loop either. A body with more blocks
 * than the closure is worth walking is reported as all cyclic: every consumer's
 * transform is an optimization, and declining it is free.
 */
export const cyclicBlocksOf = (body: IrBody): ReadonlySet<IrBlockId> => {
  const cached = cyclicBlockSets.get(body)
  if (cached) return cached
  const cyclic = computeCyclicBlocks(body)
  cyclicBlockSets.set(body, cyclic)
  return cyclic
}

const computeCyclicBlocks = (body: IrBody): ReadonlySet<IrBlockId> => {
  if (body.blockOrder.length > 256) return new Set(body.blockOrder)
  const graph = controlFlowGraphOf(body)
  const reaches = new Map<IrBlockId, Set<IrBlockId>>()
  for (const id of body.blockOrder) reaches.set(id, new Set(graph.successors.get(id) ?? []))
  let growing = true
  while (growing) {
    growing = false
    for (const id of body.blockOrder) {
      const own = reaches.get(id)
      if (own === undefined) continue
      for (const step of [...own]) {
        for (const onward of reaches.get(step) ?? []) {
          if (own.has(onward)) continue
          own.add(onward)
          growing = true
        }
      }
    }
  }
  const cyclic = new Set<IrBlockId>()
  for (const id of body.blockOrder) if (reaches.get(id)?.has(id) === true) cyclic.add(id)
  return cyclic
}

export const buildDominatorTree = (body: IrBody, graph: ControlFlowGraph): DominatorTree => {
  const order = reversePostorder(body.entry, graph.successors)
  const postorderNumber = new Map<IrBlockId, number>()
  order.forEach((block, index) => postorderNumber.set(block, order.length - 1 - index))

  const immediateDominator = new Map<IrBlockId, IrBlockId>()
  immediateDominator.set(body.entry, body.entry)

  const intersect = (left: IrBlockId, right: IrBlockId): IrBlockId => {
    let a = left
    let b = right
    while (a !== b) {
      const numberA = postorderNumber.get(a)
      const numberB = postorderNumber.get(b)
      if (numberA === undefined || numberB === undefined)
        throw new Error(`dominance intersect visited a block outside the entry component: ${a} / ${b}`)
      while (postorderNumber.get(a)! < numberB) {
        const next = immediateDominator.get(a)
        if (next === undefined) throw new Error(`dominance intersect reached unresolved block ${a} before a fixed point`)
        a = next
      }
      while (postorderNumber.get(b)! < (postorderNumber.get(a) ?? -1)) {
        const next = immediateDominator.get(b)
        if (next === undefined) throw new Error(`dominance intersect reached unresolved block ${b} before a fixed point`)
        b = next
      }
    }
    return a
  }

  let changed = true
  while (changed) {
    changed = false
    for (const block of order) {
      if (block === body.entry) continue
      const preds = graph.predecessors.get(block) ?? []
      let newIdom: IrBlockId | undefined
      for (const pred of preds) {
        if (!immediateDominator.has(pred)) continue
        newIdom = newIdom === undefined ? pred : intersect(newIdom, pred)
      }
      if (newIdom === undefined) continue
      if (immediateDominator.get(block) !== newIdom) {
        immediateDominator.set(block, newIdom)
        changed = true
      }
    }
  }

  const reachable = new Set(order)

  const dominates = (ancestor: IrBlockId, block: IrBlockId): boolean => {
    if (!reachable.has(ancestor) || !reachable.has(block)) return false
    let cursor = block
    while (true) {
      if (cursor === ancestor) return true
      const next = immediateDominator.get(cursor)
      if (next === undefined || next === cursor) return cursor === ancestor
      cursor = next
    }
  }

  return { dominates, reachable }
}

/** The block and in-block position (terminator counted last) where a value is defined; `null` if it is defined nowhere in this body. */
export interface DefinitionSite {
  readonly block: IrBlockId
  /** Phis are visible to every operation in their own block, including index 0, so they are recorded at `-1`. */
  readonly position: number
}

/** Every SSA value's unique definition site, scanned once so both the duplicate-definition guard and visibility queries share one answer. */
export const collectDefinitionSites = (body: IrBody): ReadonlyMap<IrValueId, readonly DefinitionSite[]> => {
  const sites = new Map<IrValueId, DefinitionSite[]>()
  const record = (id: IrValueId, site: DefinitionSite): void => {
    const existing = sites.get(id) ?? []
    existing.push(site)
    sites.set(id, existing)
  }
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    block.operations.forEach((operation, index) => {
      // Which operations define a value is `resultOfIrOperation`'s answer, not
      // a list repeated here: a second enumeration of the result-less kinds is
      // a second authority, and the two would disagree the first time a kind
      // is added to one of them.
      const result = resultOfIrOperation(operation)
      if (!result) return
      // A phi is defined at its block's entry, ahead of every ordinary
      // operation in it, which `-1` is the position for.
      record(result.id, { block: blockId, position: operation.kind === 'phi' ? -1 : index })
    })
  }
  return sites
}

/**
 * Whether a value defined at `definition` is visible to a use at `useBlock`/`usePosition`.
 *
 * Same-block uses require the definition to come strictly earlier; cross-block
 * uses require the defining block to dominate the using block. This is the one
 * rule both ordinary operand uses and phi incoming values are checked against
 * -- a phi's use position is simply its predecessor's exit, i.e. `Infinity`.
 */
export const isVisible = (definition: DefinitionSite, useBlock: IrBlockId, usePosition: number, dominance: DominatorTree): boolean => {
  if (definition.block === useBlock) return definition.position < usePosition
  return dominance.dominates(definition.block, useBlock)
}

/** Position sentinel for a phi's incoming-value check: the value must be visible at its predecessor's exit. */
export const atBlockExit = Number.POSITIVE_INFINITY

export interface NaturalLoop {
  readonly header: IrBlockId
  readonly blocks: ReadonlySet<IrBlockId>
}

/**
 * Every natural loop in this body, innermost first.
 *
 * A back edge is an edge into a block that DOMINATES its source: reaching the
 * source at all meant passing through the header, so following the edge runs
 * the header again. The loop is then the header plus everything that can reach
 * the source without leaving through the header, which is the backwards reach
 * from the source with the header held as the boundary.
 *
 * Innermost first because the callers that ask "which loop is this operation
 * in" want the tightest one -- a push inside two loops is filled by the inner
 * one's trip count, and a counter is bounded by its own loop's test rather
 * than by an enclosing loop's. Block count orders that correctly: a nested
 * loop's blocks are a subset of its parent's.
 */
export const naturalLoopsOf = (graph: ControlFlowGraph, dominance: DominatorTree): readonly NaturalLoop[] => {
  const loops: NaturalLoop[] = []
  for (const tail of dominance.reachable) {
    for (const header of graph.successors.get(tail) ?? []) {
      if (!dominance.dominates(header, tail)) continue
      const blocks = new Set<IrBlockId>([header, tail])
      const pending = [tail]
      while (pending.length > 0) {
        const current = pending.pop()
        if (current === undefined) continue
        for (const predecessor of graph.predecessors.get(current) ?? []) {
          if (blocks.has(predecessor)) continue
          blocks.add(predecessor)
          pending.push(predecessor)
        }
      }
      loops.push({ header, blocks })
    }
  }
  loops.sort((left, right) => left.blocks.size - right.blocks.size)
  return loops
}
