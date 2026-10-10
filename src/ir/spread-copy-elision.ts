import type { DeclarationId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { recordAccessorsOfShape, recordLayoutOfShapeId } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import { controlFlowGraphOf, dominatorTreeOf } from './dominance.js'
import { implicitSuccessorsOf } from './exception-edges.js'
import type {
  BindingReadOperation,
  BindingWriteOperation,
  GetOperation,
  IrBlockId,
  IrBody,
  IrNonTerminatorOperation,
  SpreadCopyOperation
} from './model.js'
import { observesNativeCarrierOnly, operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { effectOf } from './shake.js'
import { verifyIrBody } from './verify.js'

/**
 * A fresh object-spread copy that is only ever READ by constant key, before
 * anything can change its source, is the source: the copy is dropped and each
 * read asks the source what the copy would have held.
 *
 * A deserializer opening with `options = { ...options }` (to strip the
 * prototype chain) and then reads a dozen options by constant key before its
 * first call. Built for real that is an allocation plus a key-order-preserving
 * copy of a ~134-field native record, and its destruction, for every document
 * deserialized -- to answer reads the source answers identically. The copy is
 * unobservable here because nothing else ever holds it (its only uses are the
 * spread and the one cell it is stored into), nothing writes that cell again
 * before the reads, and nothing between the spread and the last read can write
 * the source or run code that could.
 *
 * What the copy would have held is not quite what the source holds, which is why
 * the rewritten read is flagged (`GetOperation.spreadSnapshot`) instead of
 * being a plain read: `CopyDataProperties` copies only own ENUMERABLE
 * properties, so a field the source holds non-enumerably is absent from the
 * copy. The flag makes the printer test that attribute as well as presence. The
 * rewrite is therefore limited to optional fields -- a required field has no
 * absent answer to give back -- and to a source with no accessor, whose read is
 * a load and not a call.
 *
 * Every condition below is a way the copy could be told apart from its source;
 * a body that fails any one keeps the real copy.
 *
 * - The receiver is an empty `allocate-record` whose only uses are this spread
 *   and one `binding-write` into a body-local, frame-owned cell (a closure
 *   reading the cell would see a copy it no longer has). The spread states no
 *   `later` or `overwritten` keys, source and receiver are the same accessor-free
 *   record carrier, and the write and the spread share a block with nothing
 *   unsafe between them. The block is not on a cycle: a second pass would spread
 *   the previous copy, which is a snapshot the source's later state can differ from.
 * - Every read of the cell that follows the write is dominated by it, and its
 *   result is used only as the receiver of constant-key gets of declared
 *   optional fields the spread copies (through the presence wrap the cell is
 *   stored by and the narrowing it is read back by, when its carrier is optional). Any other use -- passing the copy on,
 *   returning it, a computed key, an unknown key -- is the copy escaping.
 * - Every such get is reached from the write by clean paths only: no operation
 *   that may write the source or run program code (`ir/shake.ts`'s `effectOf`
 *   'always'; a store, unless its receiver is an object allocated after the
 *   spread; a get that is not a load off an accessor-free record or a
 *   primitive; a write to the cell) lies between them on any path. A body with
 *   a try region keeps its copy.
 */
export const elideReadOnlySpreadCopies = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  deriver: RepresentationDeriver
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const bindingBodies = new Map<DeclarationId, Set<PhysicalBodyId>>()
  for (const [id, body] of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        const declaration = bindingDeclarationOf(operation)
        if (declaration === null) continue
        const owners = bindingBodies.get(declaration)
        if (owners) owners.add(id)
        else bindingBodies.set(declaration, new Set([id]))
      }
    }
  }
  const bodyLocal = (declaration: DeclarationId, body: PhysicalBodyId): boolean => {
    const owners = bindingBodies.get(declaration)
    return owners !== undefined && owners.size === 1 && owners.has(body)
  }
  let output: Map<PhysicalBodyId, IrBody> | null = null
  for (const [id, body] of bodies) {
    const rewritten = rewriteBody(body, (declaration) => bodyLocal(declaration, id), placements, deriver)
    if (rewritten === body) continue
    output ??= new Map(bodies)
    output.set(id, rewritten)
  }
  return output ?? bodies
}

const bindingDeclarationOf = (operation: IrNonTerminatorOperation): DeclarationId | null =>
  operation.kind === 'binding-read' || operation.kind === 'binding-write' || operation.kind === 'binding-renew'
    ? operation.declaration
    : null

interface Site {
  readonly block: IrBlockId
  readonly index: number
}

interface Elision {
  readonly removed: readonly IrNonTerminatorOperation[]
  readonly rewritten: ReadonlyMap<GetOperation, GetOperation>
}

/**
 * The fields of an accessor-free, index-free record carrier, or `null` for any
 * other. A compiler-owned struct reached through a `Ref` (`native-record-ref`
 * with no host `native`) carries only its shape: the layout is the deriver's, the
 * one authority the printer's field reads ask too.
 */
export const plainRecordFieldsOf = (representation: Representation, deriver: RepresentationDeriver): readonly RecordField[] | null => {
  if (representation.kind === 'record') return representation.accessors.length === 0 ? representation.fields : null
  if (representation.kind !== 'native-record-ref' || representation.native !== null) return null
  const layout = recordLayoutOfShapeId(deriver, representation.shapeId)
  const accessors = recordAccessorsOfShape(deriver, representation.shapeId)
  return layout !== null && layout.indexes.length === 0 && accessors !== null && accessors.length === 0 ? layout.fields : null
}

/** What a read of this carrier does: a load, with no program code on its path. */
const loadsRunNoCode = (representation: Representation, deriver: RepresentationDeriver): boolean => {
  switch (representation.kind) {
    case 'record':
    case 'native-record-ref':
      return plainRecordFieldsOf(representation, deriver) !== null
    case 'scalar':
    case 'string':
    case 'null':
    case 'undefined':
      return true
    case 'optional':
      return loadsRunNoCode(representation.payload, deriver)
    case 'tagged-union':
      return representation.arms.every((arm) => loadsRunNoCode(arm.value, deriver))
    default:
      return false
  }
}

/**
 * Whether a read of an absent field has an answer in this carrier. The printer
 * spells a presence-guarded read only where one exists (`cppUndefinedIn`); a
 * field whose result cannot hold `undefined` is read unguarded, and a read that
 * must also test enumerability has nowhere to put the negative answer.
 */
const holdsUndefined = (representation: Representation): boolean =>
  representation.kind === 'undefined' ||
  representation.kind === 'dynamic' ||
  (representation.kind === 'optional' && representation.absence === 'undefined') ||
  (representation.kind === 'tagged-union' && representation.arms.some((arm) => arm.value.kind === 'undefined'))

const allocationKinds: ReadonlySet<IrNonTerminatorOperation['kind']> = new Set([
  'allocate-record',
  'allocate-ordinary-object',
  'allocate-array-object'
])

const rewriteBody = (
  body: IrBody,
  bodyLocal: (declaration: DeclarationId) => boolean,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  deriver: RepresentationDeriver
): IrBody => {
  if (body.tryRegions.length > 0) return body
  const producers = new Map<IrValueId, IrNonTerminatorOperation>()
  const uses = new Map<IrValueId, IrNonTerminatorOperation[]>()
  const bindings = new Map<DeclarationId, IrNonTerminatorOperation[]>()
  const sites = new Map<IrNonTerminatorOperation, Site>()
  const escaping = new Set<IrValueId>()
  const spreads: SpreadCopyOperation[] = []
  for (const [blockId, block] of body.blocks) {
    for (const [index, operation] of block.operations.entries()) {
      sites.set(operation, { block: blockId, index })
      const result = resultOfIrOperation(operation)
      if (result !== null) producers.set(result.id, operation)
      if (operation.kind === 'spread-copy') spreads.push(operation)
      const declaration = bindingDeclarationOf(operation)
      if (declaration !== null) {
        const list = bindings.get(declaration)
        if (list) list.push(operation)
        else bindings.set(declaration, [operation])
      }
      for (const operand of operandsOfIrOperation(operation)) {
        const list = uses.get(operand.value)
        if (list) list.push(operation)
        else uses.set(operand.value, [operation])
      }
    }
    for (const operand of operandsOfIrOperation(block.terminator)) escaping.add(operand.value)
  }
  if (spreads.length === 0) return body
  for (const region of body.iteratorCloseRegions ?? []) escaping.add(region.iterator.value)
  const graph = controlFlowGraphOf(body)
  const implicit = implicitSuccessorsOf(body, graph)
  const dominance = dominatorTreeOf(body)
  const strings = stringConstantsOf(body)
  const successorsOf = (block: IrBlockId): readonly IrBlockId[] => [...(graph.successors.get(block) ?? []), ...(implicit.get(block) ?? [])]

  // Asked of the one block the spread sits in. `cyclicBlocksOf` answers "all
  // cyclic" for a body past its size cap, and the bodies this exists for --
  // large deserializers -- are exactly the large ones.
  const onCycle = (block: IrBlockId): boolean => {
    const seen = new Set<IrBlockId>()
    const pending = [...successorsOf(block)]
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || seen.has(next)) continue
      if (next === block) return true
      seen.add(next)
      pending.push(...successorsOf(next))
    }
    return false
  }

  const elisionOf = (copy: SpreadCopyOperation): Elision | null => {
    const spreadSite = sites.get(copy)
    if (spreadSite === undefined || onCycle(spreadSite.block)) return null
    if ((copy.later?.length ?? 0) > 0 || (copy.overwritten?.length ?? 0) > 0) return null
    // `{ ...options }` over an `options` the program may hold absent copies
    // nothing from it, and a read of the empty copy answers `undefined` -- which
    // is what the flagged read answers for an absent source.
    const sourceRecord = copy.source.representation.kind === 'optional' ? copy.source.representation.payload : copy.source.representation
    const sourceFields = plainRecordFieldsOf(sourceRecord, deriver)
    if (sourceFields === null || representationKey(sourceRecord) !== representationKey(copy.receiver.representation)) return null
    if (copy.source.value === copy.receiver.value) return null
    const allocation = producers.get(copy.receiver.value)
    if (allocation?.kind !== 'allocate-record' || allocation.fields.length !== 0) return null
    const holders = uses.get(allocation.result.id) ?? []
    if (escaping.has(allocation.result.id) || holders.length !== 2 || !holders.includes(copy)) return null
    let write: IrNonTerminatorOperation | undefined = holders.find((holder) => holder !== copy)
    // The cell may hold the record optionally (`options?: DeserializeOptions`
    // is stored as `optional(record)`), so the literal reaches it through the
    // lowering's presence wrap: a conversion that adds the absent arm and
    // nothing else.
    const wraps: IrNonTerminatorOperation[] = []
    let stored = allocation.result.id
    if (write?.kind === 'convert') {
      const wrapped = write.result.representation
      if (
        write.presence !== undefined ||
        write.rebuild !== undefined ||
        write.source.value !== stored ||
        wrapped.kind !== 'optional' ||
        representationKey(wrapped.payload) !== representationKey(allocation.result.representation) ||
        escaping.has(write.result.id)
      )
        return null
      const onward = uses.get(write.result.id) ?? []
      if (onward.length !== 1) return null
      wraps.push(write)
      stored = write.result.id
      write = onward[0]
    }
    if (write?.kind !== 'binding-write' || write.value.value !== stored) return null
    const writeSite = sites.get(write)
    if (writeSite === undefined || writeSite.block !== spreadSite.block || writeSite.index <= spreadSite.index) return null
    const declaration = write.declaration
    const placement = placements.get(declaration)
    if (!bodyLocal(declaration) || placement?.storage.kind !== 'local' || placement.storage.owner !== body.sourceOwner) return null
    const cellOperations = bindings.get(declaration) ?? []
    if (cellOperations.some((operation) => operation.kind === 'binding-renew')) return null
    return reachedElision(copy, sourceFields, write, spreadSite, writeSite, declaration, [allocation, ...wraps], cellOperations)
  }

  const reachedElision = (
    copy: SpreadCopyOperation,
    sourceFields: readonly RecordField[],
    write: BindingWriteOperation,
    spreadSite: Site,
    writeSite: Site,
    declaration: DeclarationId,
    built: readonly IrNonTerminatorOperation[],
    cellOperations: readonly IrNonTerminatorOperation[]
  ): Elision | null => {
    const isFresh = (value: IrValueId): boolean => {
      const producer = producers.get(value)
      const site = producer === undefined ? undefined : sites.get(producer)
      if (producer === undefined || site === undefined || !allocationKinds.has(producer.kind)) return false
      // Allocated after the spread, so it cannot be the source: only an object
      // that did not exist when the copy was taken is safe to write.
      return site.block === spreadSite.block ? site.index > spreadSite.index : dominance.dominates(spreadSite.block, site.block)
    }
    const hazard = (operation: IrNonTerminatorOperation): boolean => {
      if (operation === write) return false
      switch (operation.kind) {
        case 'get':
          return !loadsRunNoCode(operation.receiver.representation, deriver)
        case 'binding-write':
          return operation.declaration === declaration
        case 'set':
        case 'delete':
        case 'define-own-property':
        case 'spread-copy':
          return !isFresh(operation.receiver.value)
        // An equality or nullish test over a carrier that holds a dynamic value
        // (`options['fieldsAsRaw'] == null`, a dictionary of `any`) is `always`
        // to the shaker, which cannot tell it from a loose comparison that
        // coerces. `observesNativeCarrierOnly` is the proof that it never does,
        // and a read of the cell would otherwise end at every such guard.
        case 'compute':
          return effectOf(operation) !== 'pure' && !observesNativeCarrierOnly(operation)
        default:
          return effectOf(operation) !== 'pure'
      }
    }
    const firstHazardFrom = (block: IrBlockId, from: number): number => {
      const operations = body.blocks.get(block)?.operations ?? []
      for (let index = from; index < operations.length; index++) {
        const operation = operations[index]
        if (operation !== undefined && hazard(operation)) return index
      }
      return Number.POSITIVE_INFINITY
    }
    // Forward flood from the spread. A block entered CLEAN is trusted up to its
    // first hazard; every block past a hazard is entered POISONED and poison
    // floods onward, so a block reached poisoned on any path is one where the
    // source may already have changed -- the `stable-cell-reads.ts` walk, with
    // "a write to the cell" widened to "anything that may write the source".
    const limits = new Map<IrBlockId, number>()
    const poisoned = new Set<IrBlockId>()
    const pending: { readonly block: IrBlockId; readonly clean: boolean }[] = []
    const enter = (block: IrBlockId, from: number): void => {
      const limit = firstHazardFrom(block, from)
      limits.set(block, limit)
      for (const successor of successorsOf(block)) pending.push({ block: successor, clean: limit === Number.POSITIVE_INFINITY })
    }
    enter(spreadSite.block, spreadSite.index + 1)
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined) break
      if (next.clean) {
        if (limits.has(next.block)) continue
        enter(next.block, 0)
        continue
      }
      if (poisoned.has(next.block)) continue
      poisoned.add(next.block)
      for (const successor of successorsOf(next.block)) pending.push({ block: successor, clean: false })
    }
    const cleanAt = (site: Site): boolean => !poisoned.has(site.block) && site.index < (limits.get(site.block) ?? Number.NEGATIVE_INFINITY)

    const removed: IrNonTerminatorOperation[] = [...built, copy, write]
    const rewritten = new Map<GetOperation, GetOperation>()
    for (const operation of cellOperations) {
      if (operation.kind !== 'binding-read') continue
      const read: BindingReadOperation = operation
      const readSite = sites.get(read)
      if (readSite === undefined) return null
      const sameBlock = readSite.block === spreadSite.block
      // A read the write does not precede reads the cell as it was: the source.
      if (sameBlock ? readSite.index <= writeSite.index : !limits.has(readSite.block) && !poisoned.has(readSite.block)) continue
      if (!sameBlock && !dominance.dominates(spreadSite.block, readSite.block)) return null
      if (read.reactive === true || read.closedCallable !== undefined || escaping.has(read.result.id)) return null
      // What reads the copy: a get of a declared optional field, directly or
      // through the conversion that narrows the cell's optional away. The copy
      // is always present, so that narrowing is dropped with the rest.
      const visit = (value: IrValueId, held: Representation, mayNarrow: boolean): boolean => {
        for (const use of uses.get(value) ?? []) {
          if (use.kind === 'convert') {
            if (
              !mayNarrow ||
              held.kind !== 'optional' ||
              use.source.value !== value ||
              use.rebuild !== undefined ||
              representationKey(use.result.representation) !== representationKey(held.payload) ||
              escaping.has(use.result.id)
            )
              return false
            removed.push(use)
            if (!visit(use.result.id, use.result.representation, false)) return false
            continue
          }
          if (use.kind !== 'get' || use.receiver.value !== value || use.key.value === value) return false
          if (
            use.hostMethod !== undefined ||
            use.nativeFieldOwnerRead !== undefined ||
            use.typedComputedRead !== undefined ||
            use.provenKeyTexts !== undefined ||
            use.absentClassArms !== undefined ||
            use.closedCallable !== undefined ||
            use.callableOwnPrototype !== undefined ||
            use.normalResult !== undefined ||
            use.reactive === true ||
            use.spreadSnapshot !== undefined
          )
            return false
          const key = strings.get(use.key.value)
          const field = key === undefined ? undefined : sourceFields.find((candidate) => candidate.key === key)
          if (field === undefined || field.required || (copy.keys !== undefined && !copy.keys.includes(field.key))) return false
          if (!holdsUndefined(use.result.representation)) return false
          const useSite = sites.get(use)
          if (useSite === undefined || !cleanAt(useSite)) return false
          // The standard-prototype absence fact named the copy, a fresh
          // ordinary object; the source the read now loads from is another.
          const { ordinaryObjectPrototypeKeyAbsent: _copyFact, ...sourceRead } = use
          rewritten.set(use, { ...sourceRead, receiver: copy.source, spreadSnapshot: true })
        }
        return true
      }
      if (!visit(read.result.id, read.result.representation, true)) return null
      removed.push(read)
    }
    return { removed, rewritten }
  }

  const elisions = spreads.flatMap((copy) => elisionOf(copy) ?? [])
  if (elisions.length === 0) return body
  const removed = new Set<IrNonTerminatorOperation>()
  const replaced = new Map<IrNonTerminatorOperation, GetOperation>()
  for (const elision of elisions) {
    for (const operation of elision.removed) removed.add(operation)
    for (const [original, rewritten] of elision.rewritten) replaced.set(original, rewritten)
  }
  const blocks = new Map(body.blocks)
  for (const [blockId, block] of body.blocks) {
    if (!block.operations.some((operation) => removed.has(operation) || replaced.has(operation))) continue
    const operations: IrNonTerminatorOperation[] = []
    for (const operation of block.operations) {
      if (removed.has(operation)) continue
      operations.push(replaced.get(operation) ?? operation)
    }
    blocks.set(blockId, { ...block, operations })
  }
  const values = new Map(body.values)
  for (const operation of removed) {
    const result = resultOfIrOperation(operation)
    if (result !== null) values.delete(result.id)
  }
  const elided: IrBody = { ...body, blocks, values }
  // Fail closed: a rewrite the guards reject leaves the program as lowered.
  return verifyIrBody(elided).length > 0 ? body : elided
}
