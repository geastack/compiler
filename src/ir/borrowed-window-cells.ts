import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { representationKey } from '../representation/model.js'
import { controlFlowGraphOf, dominatorTreeOf, naturalLoopsOf } from './dominance.js'
import { allOperationsOf, type IrBlockId, type IrBody } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Cells that may hold the address of the dense window cell they are written
 * from, instead of a counted copy of the element.
 *
 * `const box = boxes[i]` in a loop over a dense window stores the element into
 * `box`'s cell, and for a counted element that store is a retain and a release
 * on every turn: a collision world's raycast and groundHeight paid one per box,
 * the largest piece of a game's enemy update. The window's cell already holds
 * the element, and keeps holding it for as long as nothing changes the array.
 *
 * So the cell may name the array's cell when:
 *
 *   - the body writes it exactly once, with a window read (`windowReads`, the
 *     reads the target renders as the cell itself) that has no other use;
 *   - the innermost loop around that write changes no array storage
 *     (`mutatesArrayStorage`, `ir/hoist.ts`'s authority): no element store
 *     can replace the element and release it, and no push or call can move the
 *     storage the address points into;
 *   - every read of the cell is inside that loop and comes after the write,
 *     dominating it and earlier in `blockOrder` as `stableFieldCellsOf` asks.
 *     Both in one loop, a read always sees this turn's write: a turn that
 *     reaches the read without passing the write would give a path from entry
 *     that skips it, and the write would not dominate. A read after the loop
 *     could see storage a later push moved;
 *   - nothing else names the cell (`admits`: a closure or another frame reads
 *     it with code this body does not render), and each read wants the
 *     written carrier.
 *
 * A body with exception or iterator-close regions keeps its cells: the
 * dominator tree does not carry those edges. A suspending body keeps them too:
 * other code runs while it is suspended.
 */
export const borrowedWindowCellsOf = (
  body: IrBody,
  windowReads: ReadonlySet<IrValueId>,
  mutatesArrayStorage: (blocks: ReadonlySet<IrBlockId>) => boolean,
  admits: (declaration: DeclarationId) => boolean
): ReadonlySet<DeclarationId> => {
  if (windowReads.size === 0 || body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return new Set()
  type Site = { readonly block: IrBlockId; readonly index: number }
  const writes = new Map<DeclarationId, (Site & { readonly value: IrValueId; readonly key: string })[]>()
  const reads = new Map<DeclarationId, (Site & { readonly key: string })[]>()
  const refused = new Set<DeclarationId>()
  const uses = new Map<IrValueId, number>()
  const definedIn = new Map<IrValueId, IrBlockId>()
  for (const [block, contents] of body.blocks) {
    for (const [index, operation] of allOperationsOf(contents).entries()) {
      if (operation.kind === 'await' || operation.kind === 'yield') return new Set()
      for (const operand of operandsOfIrOperation(operation)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
      const result = resultOfIrOperation(operation)
      if (result !== null) definedIn.set(result.id, block)
      if (operation.kind === 'binding-write') {
        const sites = writes.get(operation.declaration) ?? []
        sites.push({ block, index, value: operation.value.value, key: representationKey(operation.value.representation) })
        writes.set(operation.declaration, sites)
      } else if (operation.kind === 'binding-read') {
        const sites = reads.get(operation.declaration) ?? []
        sites.push({ block, index, key: representationKey(operation.result.representation) })
        reads.set(operation.declaration, sites)
      } else if ('declaration' in operation && typeof operation.declaration === 'string') {
        refused.add(operation.declaration as DeclarationId)
      }
    }
  }
  const dominance = dominatorTreeOf(body)
  // Every back edge to one header is one loop here: a `continue` in a `while`
  // gives a header two latches, and each natural loop alone misses the blocks
  // only the other path runs in the same turn.
  const loopBlocks = new Map<IrBlockId, Set<IrBlockId>>()
  for (const loop of naturalLoopsOf(controlFlowGraphOf(body), dominance)) {
    const blocks = loopBlocks.get(loop.header) ?? new Set<IrBlockId>()
    for (const block of loop.blocks) blocks.add(block)
    loopBlocks.set(loop.header, blocks)
  }
  const innermostLoopOf = (block: IrBlockId): ReadonlySet<IrBlockId> | null => {
    let found: ReadonlySet<IrBlockId> | null = null
    for (const blocks of loopBlocks.values()) if (blocks.has(block) && (found === null || blocks.size < found.size)) found = blocks
    return found
  }
  const neutral = new Map<ReadonlySet<IrBlockId>, boolean>()
  const order = new Map(body.blockOrder.map((block, position) => [block, position]))
  const cells = new Set<DeclarationId>()
  for (const [declaration, sites] of writes) {
    const write = sites[0]
    if (sites.length !== 1 || write === undefined || refused.has(declaration)) continue
    if (!windowReads.has(write.value) || uses.get(write.value) !== 1 || !admits(declaration)) continue
    const loop = innermostLoopOf(write.block)
    const readBlock = definedIn.get(write.value)
    if (loop === null || readBlock === undefined || !loop.has(readBlock)) continue
    const unchanged = neutral.get(loop) ?? !mutatesArrayStorage(loop)
    neutral.set(loop, unchanged)
    if (!unchanged) continue
    const writeOrder = order.get(write.block)
    if (writeOrder === undefined) continue
    const after = (read: Site): boolean => {
      if (read.block === write.block) return write.index < read.index
      const readOrder = order.get(read.block)
      return readOrder !== undefined && writeOrder < readOrder && dominance.dominates(write.block, read.block)
    }
    if ((reads.get(declaration) ?? []).every((read) => loop.has(read.block) && after(read) && read.key === write.key))
      cells.add(declaration)
  }
  return cells
}
