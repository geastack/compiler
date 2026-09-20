import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { cppTypeOf } from '../targets/cpp/types.js'
import { controlFlowGraphOf, cyclicBlocksOf } from './dominance.js'
import type { IrBlockId, IrBody, IrOperation, ValueTransfer } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Relocated from `targets/cpp/captures.ts` per
 * the `IrOperand.transfer` step that moved this fact out of the target: the
 * move pipeline reasons only about the lowered IR (SSA uses, cells, control
 * flow), never about how the target renders anything, so it belongs here
 * rather than beside the printer. `cppTypeOf` stays a target import for now
 * -- `ownedFormalInputsOf`'s optional-unwrap check compares two carriers by
 * their C++ SPELLING, which is the target's own historical answer to "does
 * this conversion actually change the representation"; swapping it for
 * `representationKey` would be a behavior change (two representations can
 * share a spelling while differing in fields this key tracks, e.g.
 * `shapeId`), and this refactor's contract is byte-identical output, not a
 * better answer. Collapsing that comparison onto a pure representation
 * predicate is future work, not this step's.
 */

/**
 * Argument reads whose value is DYING at the call that takes it: the cell is
 * read ONCE in the whole unit, that read is the argument's only use, and every
 * write to the cell is in the body that reads it. Nothing can observe the cell
 * after the call, so the argument MOVES into the callee rather than copying.
 *
 * The copy is not free. A `gea::Ref` argument passed by value increments on the
 * way in and releases on the way out, and the release is a decrement, a branch,
 * and -- on the taken side -- an out-of-line destructor call clang cannot prove
 * unreachable. `binary_trees`' `build` pays that pair twice per node, for the
 * two subtrees it has just built and will never look at again. Measured on
 * `binary_trees` at 1M nodes: 41.9ms as emitted, 40.8ms with the two subtree
 * arguments moved.
 *
 * Each condition is a way the move would be OBSERVED, so none of them can be
 * relaxed for a bigger catch:
 *  - a second read anywhere in the unit -- a module-scope cell two bodies read,
 *    a cell a closure captures by reference -- would see the emptied cell.
 *  - a second use of the same read, `f(x, x)`, moves the first argument out
 *    from under the second.
 *  - a read or its single use that a loop re-enters moves once and passes an
 *    empty `Ref` on every iteration after. A loop-invariant read can live in
 *    an acyclic preheader while its SSA value is consumed in the cyclic body,
 *    so both blocks must be acyclic.
 *  - a write in ANOTHER body means the cell outlives this frame: the read is
 *    local but the storage is not.
 */
export const buildDyingArgumentIndex = (bodies: readonly IrBody[]): ReadonlySet<IrValueId> => {
  const reads = new Map<IrValueId, { readonly declaration: DeclarationId; readonly body: IrBody; readonly block: IrBlockId }>()
  const readCounts = new Map<DeclarationId, number>()
  const writeBodies = new Map<DeclarationId, Set<IrBody>>()
  const uses = new Map<IrValueId, number>()
  const passed = new Set<IrValueId>()
  const definedIn = new Map<IrValueId, IrBlockId>()
  const usedIn = new Map<IrValueId, IrBlockId>()
  for (const body of bodies) {
    for (const [blockId, block] of body.blocks) {
      for (const operation of [...block.operations, block.terminator]) {
        const produced = resultOfIrOperation(operation)
        if (produced !== null) definedIn.set(produced.id, blockId)
        for (const operand of operandsOfIrOperation(operation)) {
          uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
          usedIn.set(operand.value, blockId)
        }
        if (operation.kind === 'binding-read') {
          reads.set(operation.result.id, { declaration: operation.declaration, body, block: blockId })
          readCounts.set(operation.declaration, (readCounts.get(operation.declaration) ?? 0) + 1)
        }
        if (operation.kind === 'binding-write') {
          const bodiesOfCell = writeBodies.get(operation.declaration) ?? new Set<IrBody>()
          bodiesOfCell.add(body)
          writeBodies.set(operation.declaration, bodiesOfCell)
        }
        if (operation.kind === 'call' || operation.kind === 'construct') {
          for (const argument of operation.arguments) passed.add(argument.value)
        }
        // A field store hands the value over exactly as an argument does, and so
        // does a write into a cell -- the cell keeps what the value held, and a
        // value with one use has nothing left to keep.
        if (operation.kind === 'set' || operation.kind === 'define-own-property') passed.add(operation.value.value)
        if (operation.kind === 'binding-write') passed.add(operation.value.value)
      }
    }
  }
  const cyclic = new Map<IrBody, ReadonlySet<IrBlockId>>()
  const dying = new Set<IrValueId>()
  // A value the SAME BLOCK defines and then passes is the simplest dying shape
  // there is, and needs no cell reasoning at all: straight-line code redefines
  // it before every use, so a loop cannot carry an emptied one into the next
  // iteration and no other block can name it. `binary_trees`' `build` is
  // exactly this -- the two subtrees it has just recursed for.
  for (const [value, block] of definedIn) {
    if (reads.has(value) || !passed.has(value) || uses.get(value) !== 1) continue
    if (usedIn.get(value) === block) dying.add(value)
  }
  for (const [value, read] of reads) {
    if (!passed.has(value) || uses.get(value) !== 1) continue
    if (readCounts.get(read.declaration) !== 1) continue
    const written = writeBodies.get(read.declaration)
    if (written === undefined || written.size !== 1 || !written.has(read.body)) continue
    const blocks = cyclic.get(read.body) ?? cyclicBlocksOf(read.body)
    cyclic.set(read.body, blocks)
    const useBlock = usedIn.get(value)
    if (blocks.has(read.block) || (useBlock !== undefined && blocks.has(useBlock))) continue
    dying.add(value)
  }
  return dying
}

/**
 * Single-use SSA storage can move across a branch if the consumer cannot run
 * twice without its defining operation running again. Removing the definition
 * block from the CFG makes that loop-carried-use question explicit. Binding
 * aliases and borrowed formals are excluded later by the emitter's actual
 * storage ownership, rather than inferred from a read's source type.
 */
export const ownedDyingValuesOf = (body: IrBody): ReadonlySet<IrValueId> => {
  const definitions = new Map<IrValueId, IrBlockId>()
  const uses = new Map<IrValueId, IrBlockId[]>()
  for (const [blockId, block] of body.blocks) {
    for (const operation of [...block.operations, block.terminator]) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, blockId)
      for (const operand of operandsOfIrOperation(operation)) {
        const readers = uses.get(operand.value) ?? []
        readers.push(blockId)
        uses.set(operand.value, readers)
      }
    }
  }
  const graph = controlFlowGraphOf(body)
  const cyclic = cyclicBlocksOf(body)
  const dying = new Set<IrValueId>()
  for (const [value, definition] of definitions) {
    const readers = uses.get(value)
    if (readers?.length !== 1) continue
    const use = readers[0]
    if (use === undefined) continue
    // A value defined outside a loop can still have its sole SSA use inside
    // the loop. Moving at that use empties the storage on the first iteration
    // and every later iteration observes a null Ref. The CFG re-entry check
    // below only handles distinct definition/use blocks, so exclude cyclic
    // uses before the same-block fast path as well.
    if (cyclic.has(use)) continue
    if (use === definition) {
      dying.add(value)
      continue
    }
    // Exceptional region edges are not represented by this CFG.
    if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) continue
    const pending = [...(graph.successors.get(use) ?? [])]
    const visited = new Set<IrBlockId>()
    let reentered = false
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || next === definition || visited.has(next)) continue
      if (next === use) {
        reentered = true
        break
      }
      visited.add(next)
      pending.push(...(graph.successors.get(next) ?? []))
    }
    if (!reentered) dying.add(value)
  }
  return dying
}

/** Last uses of by-value ABI inputs, grouped by formal rather than SSA read. */
export const ownedFormalInputsOf = (
  body: IrBody
): {
  readonly arguments: ReadonlySet<IrValueId>
  readonly conversions: ReadonlySet<IrValueId>
} => {
  const arguments_ = new Set<IrValueId>()
  const conversions = new Set<IrValueId>()
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return { arguments: arguments_, conversions }
  const parameters = new Map<IrValueId, number>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'parameter' && body.abi?.parameters[operation.ordinal]?.ownership !== 'borrowed')
        parameters.set(operation.result.id, operation.ordinal)
    }
  }
  type Use = { readonly block: IrBlockId; readonly index: number; readonly operation: IrOperation; readonly value: IrValueId }
  const uses = new Map<number, Use[]>()
  for (const [blockId, block] of body.blocks) {
    for (const [index, operation] of [...block.operations, block.terminator].entries()) {
      for (const operand of operandsOfIrOperation(operation)) {
        const ordinal = parameters.get(operand.value)
        if (ordinal === undefined) continue
        const readers = uses.get(ordinal) ?? []
        readers.push({ block: blockId, index, operation, value: operand.value })
        uses.set(ordinal, readers)
      }
    }
  }
  const graph = controlFlowGraphOf(body)
  const cyclic = cyclicBlocksOf(body)
  for (const readers of uses.values()) {
    // A binding write may be a formal-cell alias, not a physical copy. Its
    // subsequent binding reads are outside this direct formal-use census.
    if (readers.some((read) => read.operation.kind === 'binding-write')) continue
    for (const read of readers) {
      if (cyclic.has(read.block)) continue
      const operation = read.operation
      if (readers.length === 1 && (operation.kind === 'call' || operation.kind === 'construct')) {
        if (operation.arguments.some((argument) => argument.value === read.value)) arguments_.add(read.value)
      }
      if (operation.kind !== 'convert') continue
      const source = operation.source.representation
      const target = operation.result.representation
      if (source.kind !== 'optional' || (target.kind !== 'string' && target.kind !== 'class-ref')) continue
      if (cppTypeOf(source.payload) !== cppTypeOf(target)) continue
      // Same-block reads may be deferred past this operation by the pure
      // expression scheduler. A different block gives a real ordering boundary.
      if (readers.some((other) => other !== read && other.block === read.block)) continue
      const reachable = new Set<IrBlockId>()
      const pending = [...(graph.successors.get(read.block) ?? [])]
      while (pending.length > 0) {
        const next = pending.pop()
        if (next === undefined || reachable.has(next)) continue
        reachable.add(next)
        pending.push(...(graph.successors.get(next) ?? []))
      }
      if (readers.some((other) => reachable.has(other.block))) continue
      conversions.add(operation.result.id)
    }
  }
  return { arguments: arguments_, conversions }
}

/**
 * The single decision `emit-narrowing.ts`'s `movedValueText` and
 * `emit-callable.ts`'s stable-borrow-entry check used to make twice, verbatim,
 * against the same two whole-program facts above plus the target's own
 * storage-ownership census (`EmitContext.ownedValues` -- carrier ownership
 * class for a capture is a separate, still target-computed Phase 3 step per
 * a program fact of the IR, not of this one). A dying read moves
 * outright (`buildDyingArgumentIndex`); an SSA-dying temporary
 * (`ownedDyingValuesOf`) moves only once storage ownership is proven, since
 * that census alone cannot tell a physical owner from a borrowed alias.
 */
export const transferOf = (
  dyingArguments: ReadonlySet<IrValueId>,
  ownedValues: ReadonlySet<IrValueId>,
  ownedDyingValues: ReadonlySet<IrValueId>,
  value: IrValueId
): ValueTransfer => (dyingArguments.has(value) || (ownedValues.has(value) && ownedDyingValues.has(value)) ? 'move' : 'retain')

/**
 * The formal-conversion half of the same pipeline (`ownedFormalInputsOf`'s
 * `conversions`): a dying by-value parameter that reaches its one use through
 * an optional-unwrap `convert` moves at the CONVERT's result, not at a read of
 * the parameter itself -- `emit.ts`'s `emitConvert` is the one renderer that
 * ever sees that result id, so this is keyed by result rather than by operand.
 */
export const transfersFormalConversion = (consumingFormalConversions: ReadonlySet<IrValueId>, resultValue: IrValueId): ValueTransfer =>
  consumingFormalConversions.has(resultValue) ? 'move' : 'retain'
