import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import { controlFlowGraphOf, dominatorTreeOf, isVisible } from '../../ir/dominance.js'
import type {
  AllocateArrayObjectOperation,
  BindingWriteOperation,
  CallOperation,
  GetOperation,
  IrBlockId,
  IrBody,
  IrOperation
} from '../../ir/model.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import { representationKey } from '../../representation/model.js'
import type { EmitContext } from './emit-context.js'
import { arrayBulkAppendMethodName } from './prototype/emit-prototype-array.js'

/**
 * The local arrays that are really a `String.fromCharCode` argument list.
 *
 * `const codes = []; for (...) codes.push(byte); return String.fromCharCode(...codes)`
 * is how a binary decoder typically reads every short key, and it is a heap `ArrayObject` (control
 * block, element storage past four doubles) built only to be drained into the
 * string the call returns. A buffer is instead the `std::string` itself: each
 * `push(x)` appends `x`'s UTF-8 spelling in the order `fromCharCode` would, and
 * the one consumer takes the string. Appending code units one at a time joins a
 * surrogate pair exactly as the single call does, because the join looks at the
 * bytes already written, so the two are the same function of the same sequence.
 *
 * Nothing else may observe the array, so every use is proved, and any use not
 * named here keeps the array: the cell is written once, by an empty allocation,
 * and is neither captured, boxed, formal nor reactive; every read of the cell is
 * the receiver of a `push` whose result nobody reads, or the argument of the one
 * whole-array `fromCharCode` spread; and that consumer cannot run twice for one
 * allocation, because it moves the string out.
 */
export interface CharCodeBufferFacts {
  readonly cells: Set<DeclarationId>
  /** The empty allocation each cell is written with, which becomes the cell's own `std::string`. */
  readonly allocations: Map<IrValueId, DeclarationId>
  /** Every read of a buffer cell: it names the cell and is never a copy. */
  readonly reads: Set<IrValueId>
  /**
   * The `get` results naming `push` on a buffer, with the buffer's cell. A prototype-method call carries no
   * receiver operand of its own -- the receiver is the `get`'s -- so the call finds its buffer here.
   */
  readonly pushCallees: Map<IrValueId, DeclarationId>
}

export const createCharCodeBufferFacts = (): CharCodeBufferFacts => ({
  cells: new Set(),
  allocations: new Map(),
  reads: new Set(),
  pushCallees: new Map()
})

interface Site<T extends IrOperation> {
  readonly operation: T
  readonly block: IrBlockId
  readonly position: number
}

const isNumberArray = (representation: { readonly kind: string }): boolean => {
  const array = representation as { readonly kind: string; readonly element?: { readonly kind: string; readonly domain?: string } }
  return array.kind === 'array-object' && array.element?.kind === 'scalar' && array.element.domain === 'number'
}

export const collectCharCodeBuffers = (ctx: EmitContext, deferrable: Set<IrValueId>, body: IrBody): void => {
  // Exception and iterator-close edges are not in the graph the single-run proof below walks.
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions ?? []).length > 0 || ctx.generatorBody) return

  const uses = new Map<IrValueId, Site<IrOperation>[]>()
  const constants = new Map<IrValueId, string>()
  const allocations = new Map<IrValueId, Site<AllocateArrayObjectOperation>>()
  const writes = new Map<DeclarationId, Site<BindingWriteOperation>[]>()
  const reads = new Map<DeclarationId, { readonly id: IrValueId; readonly site: Site<IrOperation>; readonly type: string }[]>()
  const gets = new Map<IrValueId, Site<GetOperation>>()
  const blockedDeclarations = new Set<DeclarationId>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    ;[...block.operations, block.terminator].forEach((operation, position) => {
      const site = { operation, block: blockId, position }
      for (const operand of operandsOfIrOperation(operation)) {
        const where = uses.get(operand.value) ?? []
        where.push(site)
        uses.set(operand.value, where)
      }
      if (operation.kind === 'constant') constants.set(operation.result.id, operation.text)
      if (operation.kind === 'allocate-array-object') allocations.set(operation.result.id, { operation, block: blockId, position })
      if (operation.kind === 'get') gets.set(operation.result.id, { operation, block: blockId, position })
      if (operation.kind === 'binding-write') {
        const written = writes.get(operation.declaration) ?? []
        written.push({ operation, block: blockId, position })
        writes.set(operation.declaration, written)
      } else if (operation.kind === 'binding-read') {
        const read = reads.get(operation.declaration) ?? []
        read.push({ id: operation.result.id, site, type: representationKey(operation.result.representation) })
        reads.set(operation.declaration, read)
      } else if ('declaration' in operation) {
        blockedDeclarations.add((operation as { readonly declaration: DeclarationId }).declaration)
      }
    })
  }

  let dominance: ReturnType<typeof dominatorTreeOf> | null = null
  let graph: ReturnType<typeof controlFlowGraphOf> | null = null

  /** A pack the push call's own renderer takes apart: nothing but ordinary elements, and a number array. */
  const pushArgumentIsPack = (call: CallOperation): boolean => {
    const argument = call.arguments[0]
    if (call.arguments.length !== 1 || argument === undefined) return false
    const pack = allocations.get(argument.value)?.operation
    return (
      pack !== undefined &&
      isNumberArray(pack.result.representation) &&
      pack.elements.every((slot) => slot.kind === 'element') &&
      (uses.get(argument.value)?.length ?? 0) === 1
    )
  }

  for (const [declaration, written] of writes) {
    if (written.length !== 1 || blockedDeclarations.has(declaration)) continue
    const write = written[0]!
    const allocation = allocations.get(write.operation.value.value)
    if (allocation === undefined || allocation.operation.elements.length !== 0) continue
    const representation = allocation.operation.result.representation
    if (representation.kind !== 'array-object' || !isNumberArray(representation) || representation.ownership !== 'shared-refcount') continue
    if (representation.recursive) continue
    const allocationUses = uses.get(allocation.operation.result.id) ?? []
    if (allocationUses.length !== 1 || allocationUses[0]?.operation !== write.operation) continue
    const placement = ctx.placements.get(declaration)
    if (placement?.storage.kind !== 'local' || placement.storage.owner !== ctx.owner || placement.representation === undefined) continue
    if (placement.representation === null || representationKey(placement.representation) !== representationKey(representation)) continue
    if (ctx.captures.isBoxed(declaration) || ctx.captures.isCaptured(declaration) || ctx.captures.frameMemberOf(declaration) !== null)
      continue
    if (ctx.formalCells.has(declaration) || ctx.reactiveBindingOrigins.has(declaration) || ctx.hostMethodAliases.has(declaration)) continue
    if (ctx.typeQueryBindings.has(declaration) || ctx.integerBindings.has(declaration)) continue

    dominance ??= dominatorTreeOf(body)
    graph ??= controlFlowGraphOf(body)
    const cellReads = reads.get(declaration) ?? []
    const readIds = new Set(cellReads.map((read) => read.id))
    const pushGets: IrValueId[] = []
    const consumers: Site<IrOperation>[] = []
    let admitted = cellReads.length > 0
    for (const read of cellReads) {
      if (!admitted) break
      if (read.type !== representationKey(representation) || ctx.reactiveOrigins.has(read.id)) {
        admitted = false
        break
      }
      // The write has to reach every read, or the read sees a cell that was never given its array.
      if (!isVisible({ block: write.block, position: write.position }, read.site.block, read.site.position, dominance)) admitted = false
      for (const use of uses.get(read.id) ?? []) {
        const operation = use.operation
        if (operation.kind === 'get') {
          const known = gets.get(operation.result.id)
          const method = ctx.prototypeMethodReads.get(operation.result.id)
          if (
            operation.receiver.value !== read.id ||
            known === undefined ||
            constants.get(operation.key.value) !== arrayBulkAppendMethodName ||
            method?.receiverKind !== 'array-object' ||
            method.member !== arrayBulkAppendMethodName ||
            operation.reactive === true
          ) {
            admitted = false
            break
          }
          pushGets.push(operation.result.id)
        } else if (operation.kind === 'call') {
          const spread =
            operation.numericRestHostCall?.wholeArray === true &&
            operation.numericRestHostCall.protocol === 'StringConstructor' &&
            operation.numericRestHostCall.member === 'fromCharCode' &&
            operation.arguments.length === 1 &&
            operation.arguments[0]?.value === read.id &&
            operation.receiver?.value !== read.id &&
            operation.argumentsAreSpread !== true &&
            operation.family === undefined
          if (spread) consumers.push(use)
          // A prototype-method call names its language receiver as `thisArgument`
          // with no native receiver slot; either spelling is the push's receiver.
          else if (
            (operation.receiver?.value !== read.id && operation.thisArgument?.value !== read.id) ||
            operation.callee.value === read.id ||
            operation.arguments.some((a) => a.value === read.id)
          )
            admitted = false
        } else {
          admitted = false
          break
        }
      }
    }
    if (!admitted || consumers.length !== 1) continue

    // Every use of each `push` lookup is a call of it on this cell, whose own result nobody reads.
    const pushLookups = new Set(pushGets)
    for (const lookup of pushLookups) {
      for (const use of uses.get(lookup) ?? []) {
        const operation = use.operation
        const pushed =
          operation.kind === 'call' &&
          operation.callee.value === lookup &&
          (operation.receiver === null || readIds.has(operation.receiver.value)) &&
          (operation.thisArgument === undefined || readIds.has(operation.thisArgument.value)) &&
          operation.numericRestHostCall === undefined &&
          operation.family === undefined &&
          operation.builtinShadowGuard === undefined &&
          operation.argumentsAreSpread !== true &&
          pushArgumentIsPack(operation) &&
          (operation.result === null || (uses.get(operation.result.id)?.length ?? 0) === 0)
        if (!pushed) admitted = false
      }
    }
    // Calls with the cell as receiver must all be a push of one of those lookups.
    for (const read of cellReads) {
      for (const use of uses.get(read.id) ?? []) {
        if (use.operation.kind === 'call' && !consumers.includes(use) && !pushLookups.has(use.operation.callee.value)) admitted = false
      }
    }
    if (!admitted) continue

    // The consumer moves the string out, so it may run at most once per allocation.
    const consumer = consumers[0]!
    if (consumer.block === allocation.block) {
      if (allocation.position >= consumer.position) continue
    } else {
      if (!dominance.dominates(allocation.block, consumer.block)) continue
      const seen = new Set<IrBlockId>([allocation.block])
      const pending = [...(graph.successors.get(consumer.block) ?? [])]
      let repeats = false
      while (pending.length > 0 && !repeats) {
        const next = pending.pop()!
        if (next === consumer.block) repeats = true
        if (seen.has(next)) continue
        seen.add(next)
        pending.push(...(graph.successors.get(next) ?? []))
      }
      if (repeats) continue
    }

    ctx.charCodeBuffers.cells.add(declaration)
    ctx.charCodeBuffers.allocations.set(allocation.operation.result.id, declaration)
    for (const id of readIds) ctx.charCodeBuffers.reads.add(id)
    for (const lookup of pushLookups) ctx.charCodeBuffers.pushCallees.set(lookup, declaration)
    // The allocation names the cell's own storage, so it is never an expression to withhold.
    deferrable.delete(allocation.operation.result.id)
  }
}
