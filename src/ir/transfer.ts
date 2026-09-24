import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { cppTypeOf } from '../targets/cpp/types.js'
import { controlFlowGraphOf, cyclicBlocksOf } from './dominance.js'
import { implicitSuccessorsOf } from './exception-edges.js'
import { loopInvariantHoistsOf, type HoistPlan } from './hoist.js'
import type { IrBlockId, IrBody, IrOperand, IrOperation, ValueTransfer } from './model.js'
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
 * A store of a constructor's formal into `this` that is emitted AFTER the
 * operation at `anchor` of its block rather than where it was written, so the
 * reads of the formal that follow it in the source run first and the store is
 * the formal's last use (`planStoreSink`).
 */
export interface SunkStore {
  readonly block: IrBlockId
  readonly anchor: number
}

/** The dying reads, and the stores whose emission position moved to make them dying. */
export class DyingArgumentSet extends Set<IrValueId> {
  /** Keyed by the stored value's read id. */
  readonly sunkStores = new Map<IrValueId, SunkStore>()
}

/**
 * Where each value is actually defined once `hoist.ts` has run: its own block,
 * or the preheader a loop-invariant operation is relocated into.
 *
 * Every rule below reasons about the definition's block, and the IR still
 * places a relocated operation in the loop body beside its use. Read there, a
 * hoisted `a + '!'` or cell read passed to a call looks defined and consumed in
 * one block -- the shape that can never be re-entered without being redefined
 * -- while the printer defines it once above the loop and moves it on the first
 * iteration, leaving every later iteration an empty string or a null `Ref`
 * (skytail a2bab0f's mip-upload loop).
 */
const landingsOf = (hoists: HoistPlan): ReadonlyMap<IrValueId, IrBlockId> => {
  const landings = new Map<IrValueId, IrBlockId>()
  for (const [block, operations] of hoists.into) {
    for (const operation of operations) {
      const result = resultOfIrOperation(operation)
      if (result !== null && hoists.relocated.has(result.id)) landings.set(result.id, block)
    }
  }
  return landings
}

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
export const buildDyingArgumentIndex = (
  bodies: readonly IrBody[],
  isConstructorBody: (body: IrBody) => boolean = () => false,
  isStoreSinkConstructor: (body: IrBody) => boolean = () => false
): DyingArgumentSet => {
  const reads = new Map<IrValueId, { readonly declaration: DeclarationId; readonly body: IrBody; readonly block: IrBlockId }>()
  const readCounts = new Map<DeclarationId, number>()
  const writeBodies = new Map<DeclarationId, Set<IrBody>>()
  const uses = new Map<IrValueId, number>()
  const passed = new Set<IrValueId>()
  const definedIn = new Map<IrValueId, IrBlockId>()
  const usedIn = new Map<IrValueId, IrBlockId>()
  // A `receiver` or `parameter` operation does not copy its formal: the
  // emitter names the frame's own `gea_this`/`gea_arg_N` for it
  // (`targets/cpp/emit.ts`'s `emitReceiver`). Two such operations over one
  // formal are two names for one storage, so a move through either empties
  // what the other reads -- `this.m(new E(this))` in an arrow reads the
  // receiver twice, moved the argument's read into `E`, and called `m` on a
  // null handle (mongodb's `ConnectionPool` constructor).
  const formalOf = new Map<IrValueId, string>()
  const formalReads = new Map<string, number>()
  for (const [bodyIndex, body] of bodies.entries()) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'receiver' && operation.kind !== 'parameter') continue
        const formal = operation.kind === 'receiver' ? `${bodyIndex}|receiver` : `${bodyIndex}|parameter|${operation.ordinal}`
        formalOf.set(operation.result.id, formal)
        formalReads.set(formal, (formalReads.get(formal) ?? 0) + 1)
      }
    }
  }
  for (const body of bodies) {
    const landings = landingsOf(loopInvariantHoistsOf(body))
    for (const [blockId, block] of body.blocks) {
      for (const operation of [...block.operations, block.terminator]) {
        const produced = resultOfIrOperation(operation)
        if (produced !== null) definedIn.set(produced.id, landings.get(produced.id) ?? blockId)
        for (const operand of operandsOfIrOperation(operation)) {
          uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
          usedIn.set(operand.value, blockId)
        }
        if (operation.kind === 'binding-read') {
          reads.set(operation.result.id, { declaration: operation.declaration, body, block: landings.get(operation.result.id) ?? blockId })
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
  const dying = new DyingArgumentSet()
  // A plugin-declared reactive field is a cell with subscribers: a write notifies them, and a
  // subscriber may read a field that is still unset. A write needs a subscriber, a subscriber
  // needs a reactive read somewhere in the program, so a program with no reactive read at all
  // cannot observe a held-back store, and any program with one keeps every store in place.
  const programIsReactive = bodies.some((body) =>
    [...body.blocks.values()].some((block) =>
      block.operations.some((operation) => (operation.kind === 'get' || operation.kind === 'binding-read') && operation.reactive === true)
    )
  )
  const storeSinkAllowed = (body: IrBody): boolean => !programIsReactive && isStoreSinkConstructor(body)
  // A value the SAME BLOCK defines and then passes is the simplest dying shape
  // there is, and needs no cell reasoning at all: straight-line code redefines
  // it before every use, so a loop cannot carry an emptied one into the next
  // iteration and no other block can name it. `binary_trees`' `build` is
  // exactly this -- the two subtrees it has just recursed for.
  const sharesFormal = (value: IrValueId): boolean => {
    const formal = formalOf.get(value)
    return formal !== undefined && (formalReads.get(formal) ?? 0) > 1
  }
  for (const [value, block] of definedIn) {
    if (reads.has(value) || !passed.has(value) || uses.get(value) !== 1 || sharesFormal(value)) continue
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
  for (const value of constructorFormalLastReadsOf(bodies, isConstructorBody, storeSinkAllowed, readCounts, writeBodies, dying.sunkStores))
    dying.add(value)
  return dying
}

/**
 * The last read of a constructor's formal that the body reads several times
 * and finally keeps (`this.options = options`).
 *
 * `buildDyingArgumentIndex` moves a cell's read only when the cell is read ONCE
 * in the whole unit. A constructor that reads fields off its `options` argument
 * and then stores the handle reads the formal's cell many times, so the store
 * copied the handle and the parameter died with the call: one count dip per
 * stored argument, of an object that is alive again a moment later -- which the
 * cycle collector buffered, probed and forgot (the mongodb driver's request
 * objects: dozens of spilled dips per operation). A class constructor is entered
 * only from its construct function, which hands it OWNED arguments, so the
 * store may take the formal's own reference whenever nothing can read the cell
 * afterwards.
 *
 * Conservative on every axis that would make the move observable: the cell is
 * the formal's alias (written once, by a by-value `parameter`) and is read
 * nowhere but this body; exactly one use of all its reads transfers (a field
 * store's value, a call or construct argument), every other use is a read in
 * place; none of those shares the transferring use's block (the expression
 * scheduler may defer a pure read in the same block past the statement that
 * moves); the block is not on a cycle and no other use is reachable from it
 * (exception edges included); and a body with a `try` or an iterator-close
 * region is left alone.
 */
const constructorFormalLastReadsOf = (
  bodies: readonly IrBody[],
  isConstructorBody: (body: IrBody) => boolean,
  isStoreSinkConstructor: (body: IrBody) => boolean,
  readCounts: ReadonlyMap<DeclarationId, number>,
  writeBodies: ReadonlyMap<DeclarationId, ReadonlySet<IrBody>>,
  sunk: Map<IrValueId, SunkStore>
): ReadonlySet<IrValueId> => {
  const dying = new Set<IrValueId>()
  for (const body of bodies) {
    const abi = body.abi
    if (!abi || body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) continue
    const owned = new Set<IrValueId>()
    const borrowedFormals = new Set<IrValueId>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'parameter' && abi.parameters[operation.ordinal]?.ownership === 'borrowed')
          borrowedFormals.add(operation.result.id)
        if (operation.kind === 'parameter' && abi.parameters[operation.ordinal]?.ownership !== 'borrowed') owned.add(operation.result.id)
      }
    }
    const written = new Map<DeclarationId, IrValueId[]>()
    const cellOf = new Map<IrValueId, DeclarationId>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'binding-write') {
          const values = written.get(operation.declaration) ?? []
          values.push(operation.value.value)
          written.set(operation.declaration, values)
        }
        if (operation.kind === 'binding-read') cellOf.set(operation.result.id, operation.declaration)
      }
    }
    const reads = new Map<DeclarationId, number>()
    for (const declaration of cellOf.values()) reads.set(declaration, (reads.get(declaration) ?? 0) + 1)
    const formalCells = new Set<DeclarationId>()
    for (const [declaration, values] of written) {
      const only = values[0]
      const count = reads.get(declaration) ?? 0
      if (values.length !== 1 || only === undefined || count < 2) continue
      // A constructor's by-value formal is always its own copy; for any other cell the
      // emitter's storage-ownership pass decides, exactly as for the single-read move.
      if (borrowedFormals.has(only) || (isConstructorBody(body) && !owned.has(only))) continue
      if (readCounts.get(declaration) !== count || writeBodies.get(declaration)?.size !== 1) continue
      formalCells.add(declaration)
    }
    if (formalCells.size === 0) continue
    type Use = { readonly block: IrBlockId; readonly index: number; readonly transferring: boolean; readonly value: IrValueId }
    const uses = new Map<DeclarationId, Use[]>()
    for (const [blockId, block] of body.blocks) {
      for (const [index, operation] of [...block.operations, block.terminator].entries()) {
        const transferring = new Set(
          operation.kind === 'set' ||
            operation.kind === 'define-own-property' ||
            operation.kind === 'call' ||
            operation.kind === 'construct'
            ? transferringOperandsOf(operation)
            : []
        )
        for (const operand of operandsOfIrOperation(operation)) {
          const declaration = cellOf.get(operand.value)
          if (declaration === undefined || !formalCells.has(declaration)) continue
          const sites = uses.get(declaration) ?? []
          sites.push({ block: blockId, index, transferring: transferring.has(operand), value: operand.value })
          uses.set(declaration, sites)
        }
      }
    }
    const graph = controlFlowGraphOf(body)
    const implicit = implicitSuccessorsOf(body, graph)
    const successorsOf = (block: IrBlockId): readonly IrBlockId[] => [
      ...(graph.successors.get(block) ?? []),
      ...(implicit.get(block) ?? [])
    ]
    const cyclic = cyclicBlocksOf(body)
    // The expression scheduler may withhold a pure value and spell it at its one
    // consumer, so an earlier read in the use's block is safe to precede the move
    // only when everything it feeds is itself placed before the moving operation:
    // then no deferral can carry the read of the emptied cell past the move.
    const consumers = new Map<IrValueId, { readonly block: IrBlockId; readonly index: number }[]>()
    for (const [blockId, block] of body.blocks) {
      for (const [index, operation] of [...block.operations, block.terminator].entries()) {
        for (const operand of operandsOfIrOperation(operation)) {
          const list = consumers.get(operand.value) ?? []
          list.push({ block: blockId, index })
          consumers.set(operand.value, list)
        }
      }
    }
    const settlesBeforeIn = (blockId: IrBlockId, index: number, limit: number, depth = 0): boolean => {
      if (index >= limit || depth > 16) return false
      const block = body.blocks.get(blockId)
      const operation = block === undefined ? undefined : [...block.operations, block.terminator][index]
      if (operation === undefined) return false
      const result = resultOfIrOperation(operation)
      if (!result) return true
      for (const consumer of consumers.get(result.id) ?? []) {
        if (consumer.block !== blockId) continue
        if (!settlesBeforeIn(blockId, consumer.index, limit, depth + 1)) return false
      }
      return true
    }
    // `this` of a constructor is unobservable until the constructor returns, as long as
    // the body only reads and writes fields through it. Then a store into `this` can be
    // emitted later than it is written, provided nothing between the two positions reads
    // that field or can throw past it with the store pending (a throw discards the object).
    // Every use of `this` renders its own `receiver` operation.
    const receiverIds = new Set<IrValueId>()
    for (const block of body.blocks.values())
      for (const operation of block.operations) if (operation.kind === 'receiver') receiverIds.add(operation.result.id)
    const constantTexts = new Map<IrValueId, string>()
    for (const block of body.blocks.values())
      for (const operation of block.operations) if (operation.kind === 'constant') constantTexts.set(operation.result.id, operation.text)
    let thisStaysPrivate: boolean | null = null
    const receiverIsPrivate = (): boolean => {
      if (thisStaysPrivate !== null) return thisStaysPrivate
      thisStaysPrivate = receiverIds.size > 0
      for (const block of body.blocks.values()) {
        for (const operation of [...block.operations, block.terminator]) {
          for (const operand of operandsOfIrOperation(operation)) {
            if (!receiverIds.has(operand.value)) continue
            const asReceiver = (operation.kind === 'set' || operation.kind === 'get') && receiverIds.has(operation.receiver.value)
            const asPayload = operation.kind === 'set' && receiverIds.has(operation.value.value)
            if (!asReceiver || asPayload) thisStaysPrivate = false
          }
        }
      }
      return thisStaysPrivate
    }
    const chainEndIn = (blockId: IrBlockId, index: number, depth = 0): number => {
      if (depth > 16) return Number.POSITIVE_INFINITY
      const block = body.blocks.get(blockId)
      const operation = block === undefined ? undefined : [...block.operations, block.terminator][index]
      const result = operation === undefined ? null : resultOfIrOperation(operation)
      let end = index
      for (const consumer of result === null ? [] : (consumers.get(result.id) ?? [])) {
        if (consumer.block === blockId) end = Math.max(end, chainEndIn(blockId, consumer.index, depth + 1))
      }
      return end
    }
    const planStoreSink = (blockId: IrBlockId, storeIndex: number, later: readonly { readonly index: number }[]): SunkStore | null => {
      const block = body.blocks.get(blockId)
      const store = block?.operations[storeIndex]
      if (block === undefined || store === undefined || store.kind !== 'set' || receiverIds.size === 0) return null
      if (!receiverIds.has(store.receiver.value) || !receiverIsPrivate()) return null
      const storeKey = constantTexts.get(store.key.value)
      if (storeKey === undefined || (store.result !== null && (consumers.get(store.result.id)?.length ?? 0) > 0)) return null
      let anchor = storeIndex
      for (const site of later) anchor = Math.max(anchor, chainEndIn(blockId, site.index))
      if (!Number.isFinite(anchor) || anchor >= block.operations.length) return null
      for (let index = storeIndex + 1; index <= anchor; index += 1) {
        const operation = block.operations[index]!
        switch (operation.kind) {
          case 'constant':
          case 'receiver':
          case 'binding-read':
          case 'compute':
            break
          case 'get':
            if (receiverIds.has(operation.receiver.value)) return null
            break
          case 'set': {
            const key = constantTexts.get(operation.key.value)
            if (!receiverIds.has(operation.receiver.value) || key === undefined || key === storeKey) return null
            break
          }
          default:
            return null
        }
      }
      return { block: blockId, anchor }
    }
    for (const sites of uses.values()) {
      const transferring = sites.filter((site) => site.transferring)
      if (transferring.length !== 1) continue
      const use = transferring[0]!
      if (cyclic.has(use.block)) continue
      if (sites.some((site) => site !== use && site.value === use.value)) continue
      const sameBlock = sites.filter((site) => site !== use && site.block === use.block)
      if (sameBlock.some((site) => site.index < use.index && !settlesBeforeIn(use.block, site.index, use.index))) continue
      const later = sameBlock.filter((site) => site.index > use.index)
      let sink: SunkStore | null = null
      if (later.length > 0) {
        sink = isConstructorBody(body) && isStoreSinkConstructor(body) ? planStoreSink(use.block, use.index, later) : null
        if (sink === null) continue
      }
      const others = new Set(sites.filter((site) => site !== use).map((site) => site.block))
      const pending = [...successorsOf(use.block)]
      const visited = new Set<IrBlockId>()
      let wanted = false
      while (pending.length > 0) {
        const next = pending.pop()
        if (next === undefined || visited.has(next)) continue
        if (next === use.block || others.has(next)) {
          wanted = true
          break
        }
        visited.add(next)
        pending.push(...successorsOf(next))
      }
      if (wanted) continue
      dying.add(use.value)
      if (sink !== null) sunk.set(use.value, sink)
    }
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
export const ownedDyingValuesOf = (body: IrBody, hoists: HoistPlan): ReadonlySet<IrValueId> => {
  const landings = landingsOf(hoists)
  const definitions = new Map<IrValueId, IrBlockId>()
  const uses = new Map<IrValueId, IrBlockId[]>()
  for (const [blockId, block] of body.blocks) {
    for (const operation of [...block.operations, block.terminator]) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, landings.get(result.id) ?? blockId)
      for (const operand of operandsOfIrOperation(operation)) {
        const readers = uses.get(operand.value) ?? []
        readers.push(blockId)
        uses.set(operand.value, readers)
      }
    }
  }
  const graph = controlFlowGraphOf(body)
  const dying = new Set<IrValueId>()
  for (const [value, definition] of definitions) {
    const readers = uses.get(value)
    if (readers?.length !== 1) continue
    const use = readers[0]
    if (use === undefined) continue
    // Defined and consumed in ONE block: the definition dominates the use, so
    // every execution of the block writes the storage before the use reads it.
    // A loop re-entering the block re-runs the definition first, so the move
    // can never be observed by a later iteration -- the same argument
    // `buildDyingArgumentIndex` makes for a value a block defines and passes.
    // This is what a `for`/`for-in` body is made of: `b = read(k)` inside a
    // loop copied a whole string or union per iteration because its block was
    // cyclic, although nothing could ever read the temporary again.
    if (use === definition) {
      dying.add(value)
      continue
    }
    // A value defined outside a loop can still have its sole SSA use inside
    // the loop. Moving at that use empties the storage on the first iteration
    // and every later iteration observes a null Ref. That is exactly what the
    // re-entry search below decides: it walks forward from the use with the
    // DEFINITION block removed from the graph, so it finds the use again only
    // when some path re-enters it without redefining the value first. A use in
    // a loop whose every trip runs the definition (`k = cursor.next()` in one
    // block, `key = k` in the next) is not re-entered by that measure, and a
    // use in a loop the definition sits outside of is.
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

/**
 * Merge inputs that die at the merge write: a value whose ONLY use is a `phi`
 * and that is defined in the very predecessor block the merge is written
 * from. `emitBody` writes every merge at the end of the predecessor, after
 * that block's own operations, so the definition runs before the write on
 * every visit of the block and no later iteration can observe the emptied
 * storage -- the same straight-line argument `ownedDyingValuesOf` makes for
 * a value one block defines and consumes. `ownedDyingValuesOf` records the
 * phi's use in the block that holds the phi, which is what keeps it from
 * answering this: the write does not happen there.
 *
 * A value defined in some OTHER block than the predecessor is left alone. The
 * write runs on every visit of the predecessor whichever way it then
 * branches, and a predecessor re-entered around a loop that does not pass
 * the definition would move an already-moved value.
 */
export const ownedDyingMergeInputsOf = (body: IrBody): ReadonlySet<IrValueId> => {
  const definedIn = new Map<IrValueId, IrBlockId>()
  const uses = new Map<IrValueId, number>()
  for (const [blockId, block] of body.blocks) {
    for (const operation of [...block.operations, block.terminator]) {
      const result = resultOfIrOperation(operation)
      if (result) definedIn.set(result.id, blockId)
      for (const operand of operandsOfIrOperation(operation)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
    }
  }
  const dying = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'phi') continue
      for (const incoming of operation.incoming) {
        if (uses.get(incoming.value.value) === 1 && definedIn.get(incoming.value.value) === incoming.block) dying.add(incoming.value.value)
      }
    }
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
  value: IrValueId,
  renames: ReadonlyMap<IrValueId, IrValueId> = new Map()
): ValueTransfer =>
  dyingArguments.has(value) || (ownedValues.has(renames.get(value) ?? value) && ownedDyingValues.has(value)) ? 'move' : 'retain'

/**
 * The formal-conversion half of the same pipeline (`ownedFormalInputsOf`'s
 * `conversions`): a dying by-value parameter that reaches its one use through
 * an optional-unwrap `convert` moves at the CONVERT's result, not at a read of
 * the parameter itself -- `emit.ts`'s `emitConvert` is the one renderer that
 * ever sees that result id, so this is keyed by result rather than by operand.
 */
export const transfersFormalConversion = (consumingFormalConversions: ReadonlySet<IrValueId>, resultValue: IrValueId): ValueTransfer =>
  consumingFormalConversions.has(resultValue) ? 'move' : 'retain'

/**
 * The operands a renderer may MOVE out of: the value of a store or a binding
 * write, a call's arguments, a conversion's source, a merge input. A receiver,
 * a property key, a callee, a branch condition, a `compute` operand and a
 * `switch` test are only ever read in place -- no renderer asks
 * `movedValueText` for one -- so a value that flows into such a role before
 * its one transferring use can still hand its storage over there.
 *
 * Any role not named here counts as transferring. Getting that wrong in this
 * direction only loses a move; a role called read-only that some renderer
 * does move from would empty the value under a later reader.
 */
const transferringOperandsOf = (operation: IrOperation): readonly IrOperand[] => {
  switch (operation.kind) {
    case 'get':
    case 'has-property':
    case 'delete':
    case 'own-property-keys':
    case 'compute':
    case 'branch':
    case 'switch':
      return []
    case 'set':
    case 'define-own-property':
      return [operation.value]
    case 'call':
      return operation.arguments
    case 'construct':
      return operation.arguments
    default:
      return operandsOfIrOperation(operation)
  }
}

/**
 * Values that die at their one TRANSFERRING use (`transferringOperandsOf`),
 * whatever else reads them first.
 *
 * `ownedDyingValuesOf` moves a value with exactly one use of any kind. That
 * leaves every record a body allocates, fills field by field and then widens
 * into a union or stores into a cell: the allocation's result is the
 * receiver of each field store and then the source of the widening, so it
 * has several uses and the widening copied it -- one retain, one release and
 * one cycle-candidate buffering per record, in `WriteConcern.fromOptions`
 * and every other options-record constructor of the mongodb driver. A
 * receiver use is a read in place, and once every such read is behind the
 * transferring use on every path the storage is free to go.
 *
 * "Behind on every path" is a forward walk from the transferring use over
 * the control-flow graph plus the exception edges it does not carry
 * (`implicitSuccessorsOf`), which is what lets this answer inside a body
 * with a `try` -- every `async` body of the driver -- where
 * `ownedDyingValuesOf` refuses the cross-block case outright. A block that
 * reads the value anywhere on that walk keeps the copy; the defining block
 * ends the walk, since entering it again runs the definition before any
 * read (a value defined and consumed inside a loop body), while a use block
 * reached again WITHOUT passing the definition is the loop-carried case
 * that must keep the copy. A merge input is used where `emitBody` writes it,
 * at the end of the incoming block. An operation naming the value twice
 * (`o.x = o`) keeps the copy: the two operands' evaluation order is C++'s.
 */
export const dyingTransferUsesOf = (body: IrBody): ReadonlySet<IrValueId> => {
  type Use = { readonly block: IrBlockId; readonly index: number; readonly transferring: boolean }
  const uses = new Map<IrValueId, Use[]>()
  const definedIn = new Map<IrValueId, IrBlockId>()
  const renames = receiverRenamesOf(body)
  const record = (value: IrValueId, use: Use): void => {
    const root = renames.get(value) ?? value
    const sites = uses.get(root)
    if (sites) sites.push(use)
    else uses.set(root, [use])
  }
  for (const [blockId, block] of body.blocks) {
    for (const [index, operation] of block.operations.entries()) {
      const result = resultOfIrOperation(operation)
      if (result && !renames.has(result.id)) definedIn.set(result.id, blockId)
      if (operation.kind === 'phi') {
        for (const incoming of operation.incoming) {
          record(incoming.value.value, {
            block: incoming.block,
            index: body.blocks.get(incoming.block)?.operations.length ?? 0,
            transferring: true
          })
        }
        continue
      }
      const transferring = new Set(transferringOperandsOf(operation))
      for (const operand of operandsOfIrOperation(operation))
        record(operand.value, { block: blockId, index, transferring: transferring.has(operand) })
    }
    const transferring = new Set(transferringOperandsOf(block.terminator))
    for (const operand of operandsOfIrOperation(block.terminator)) {
      record(operand.value, { block: blockId, index: block.operations.length, transferring: transferring.has(operand) })
    }
  }
  const graph = controlFlowGraphOf(body)
  const implicit = implicitSuccessorsOf(body, graph)
  const successorsOf = (block: IrBlockId): readonly IrBlockId[] => [...(graph.successors.get(block) ?? []), ...(implicit.get(block) ?? [])]
  const dying = new Set<IrValueId>()
  const debug = process.env.GEA_TRANSFER_DEBUG === '1'
  const report = (value: IrValueId, verdict: string, sites: readonly Use[]): void => {
    if (!debug) return
    const spelled = sites.map((site) => `${site.block}:${site.index}${site.transferring ? 'T' : 'r'}`).join(' ')
    console.error(`[transfer] ${String(body.owner)} value=${String(value)} ${verdict} uses=${spelled}`)
  }
  for (const [value, sites] of uses) {
    const definition = definedIn.get(value)
    if (definition === undefined) continue
    const transferring = sites.filter((site) => site.transferring)
    if (transferring.length !== 1) {
      report(value, `transferring-uses=${transferring.length}`, sites)
      continue
    }
    const use = transferring[0]!
    // A second operand of the same operation, in any role, or a read later
    // in the same block: the storage is still wanted after the move.
    if (sites.some((site) => site !== use && site.block === use.block && site.index >= use.index)) {
      report(value, 'read-after-transfer-in-block', sites)
      continue
    }
    const readIn = new Set(sites.filter((site) => site !== use).map((site) => site.block))
    const pending = [...successorsOf(use.block)]
    const visited = new Set<IrBlockId>()
    let wanted = false
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || next === definition || visited.has(next)) continue
      if (next === use.block || readIn.has(next)) {
        wanted = true
        break
      }
      visited.add(next)
      pending.push(...successorsOf(next))
    }
    report(value, wanted ? 'wanted-on-a-later-path' : 'dying', sites)
    if (!wanted) dying.add(value)
  }
  // A renamed view of a dying root is asked for by its own id at the one
  // transferring use (`o = {}; o.a = 1; f(o)` hands `f` the store's result).
  for (const [alias, root] of renames) if (dying.has(root)) dying.add(alias)
  return dying
}

/**
 * Results that are the same storage as an operand: a property store's result
 * is its receiver, renamed after the write (`emit-properties.ts`'s
 * `emitFieldStoreLines` defines it as an alias of the receiver's text), and a
 * chain of stores on one fresh literal is a chain of such renames. Each is
 * mapped to the ROOT of its chain -- the value that owns the storage -- which
 * is the value a move takes from and the value whose ownership decides it.
 */
export const receiverRenamesOf = (body: IrBody): ReadonlyMap<IrValueId, IrValueId> => {
  const roots = new Map<IrValueId, IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if ((operation.kind !== 'set' && operation.kind !== 'define-own-property') || operation.result === null) continue
      roots.set(operation.result.id, roots.get(operation.receiver.value) ?? operation.receiver.value)
    }
  }
  return roots
}
