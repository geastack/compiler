import { irValueId, type DeclarationId, type IrValueId, type PhysicalBodyId, type SemanticResultId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classFamilyOverridesOf } from '../projection/dispatch.js'
import { classMemberOf, recordAccessorsOfShape, recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import { controlFlowGraphOf } from './dominance.js'
import type {
  CallOperation,
  ConvertOperation,
  GetOperation,
  IrArrayElement,
  IrBlock,
  IrBlockId,
  IrBody,
  IrNonTerminatorOperation,
  IrOperand,
  IrPhiIncoming,
  IrRecordFieldInit,
  IrSwitchCase,
  IrTerminatorOperation,
  PhiOperation,
  SetOperation
} from './model.js'
import { arrayAllocationDrainsDynamicIterator, operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { verifyIrBody } from './verify.js'
import { inertArgument, nativeData, primitive } from './write-effects.js'

/**
 * Reuse a field read that an earlier read of the same field already answered.
 *
 * A slab test over `boxes` reads `box.min` and `box.max` once per axis, six
 * reads of two fields with nothing between them that can store either. V8
 * eliminates the repeated loads; clang cannot, because each one is a call
 * through a live-view check that hands back a retained handle, and the retain
 * and release around it are calls too. Here the reads are the same IR
 * operation on the same receiver, and this pass can see that nothing between
 * them stores the key or runs code, so the later read takes the earlier
 * read's value.
 *
 * Forward availability over the body's control flow, intersected at joins:
 * a read is available at an operation when every path from the entry passes
 * through it and nothing on the path after it may change what it read. Being
 * available on every path is what makes the earlier read dominate the later
 * one, so the rewrite never uses a value its definition does not reach.
 *
 * The receiver is named by the SSA value or, for a binding read, by the cell:
 * `box.min.x` and `box.max.x` read `box` twice, and both reads see the cell's
 * one value until something writes it. A read qualifies only when it loads a
 * data field no getter can answer, on any class or record that carries the
 * key, so reusing it runs nothing less than the original did. Anything that
 * can run the program's code -- a call, a coercion, an accessor -- forgets
 * every read; a store forgets the reads of its key, on every receiver, since
 * two names can be one object. A body with a try region is left alone: its
 * exceptional edges are not in the graph this walks.
 */
export const reuseFieldReads = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const codeFree = codeFreeFieldReadOf([...bodies.values()], classes, deriver)
  let output: Map<PhysicalBodyId, IrBody> | null = null
  for (const [id, body] of bodies) {
    const reused = reusedBody(body, codeFree)
    if (reused === body) continue
    output ??= new Map(bodies)
    output.set(id, reused)
  }
  return output ?? bodies
}

/** Whether reading `key` off a value carried as `receiver` loads a data field no getter of the program can answer. */
export type CodeFreeFieldRead = (receiver: Representation, key: string) => boolean

/**
 * The one answer to which field reads this pass, and the borrowed reads that
 * lean on the same proof (`borrowed-field-reads.ts`), may treat as a load.
 */
export const codeFreeFieldReadOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): CodeFreeFieldRead => {
  const accessorKeys = accessorKeysOf(bodies, classes, deriver)
  return (receiver, key) => {
    // A class instance is read through its own family's members, never a
    // view's origin, so only a record answers to another shape's getter:
    // three's `Euler` declaring `get x()` says nothing about `Vector3.x`.
    if (receiver.kind === 'class-ref') {
      if (classes.get(receiver.declaration)?.nativeBase !== null) return false
      return (
        classMemberOf(classes, receiver.declaration, key)?.kind === 'field' &&
        classFamilyOverridesOf(classes, receiver.declaration, key).length === 0
      )
    }
    if (accessorKeys.has(key)) return false
    if (receiver.kind === 'record') return receiver.fields.some((field) => field.key === key)
    if (receiver.kind === 'native-record-ref' && receiver.native === null)
      return recordFieldsOfShape(deriver, receiver.shapeId)?.some((field) => field.key === key) ?? false
    return false
  }
}

/**
 * Every key some getter or setter answers: a class accessor, or an accessor
 * of a record shape a value of the program is carried as. A record viewed as
 * another shape reads through its origin, so a field of the viewed shape can
 * still be answered by a getter of the shape it came from.
 */
const accessorKeysOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): ReadonlySet<string> => {
  const keys = new Set<string>()
  for (const layout of classes.values()) for (const accessor of layout.accessors) keys.add(accessor.key)
  const seen = new Set<Representation>()
  const shapes = new Set<string>()
  const visit = (representation: Representation): void => {
    if (seen.has(representation)) return
    seen.add(representation)
    if (representation.kind === 'optional') return visit(representation.payload)
    if (representation.kind === 'tagged-union') {
      for (const arm of representation.arms) visit(arm.value)
      return
    }
    if (representation.kind === 'record') {
      for (const accessor of representation.accessors) keys.add(accessor.key)
      for (const field of representation.fields) visit(field.value)
      return
    }
    if (representation.kind === 'native-record-ref' && representation.native === null && !shapes.has(representation.shapeId)) {
      shapes.add(representation.shapeId)
      for (const accessor of recordAccessorsOfShape(deriver, representation.shapeId) ?? []) keys.add(accessor.key)
      for (const field of recordFieldsOfShape(deriver, representation.shapeId) ?? []) visit(field.value)
    }
  }
  for (const body of bodies) for (const representation of body.values.values()) visit(representation)
  return keys
}

/** What a read is available as: its result, and the receiver and key it read. */
interface Available {
  readonly receiver: string
  readonly key: string
  readonly shape: string
  readonly value: IrValueId
  readonly representation: Representation
  readonly lineage: SemanticResultId
}

/**
 * Everything a read is besides its own identity. Two reads with the same
 * shape on the same receiver render the same load; any published fact that
 * differs between them (a reactive marker, a recipe, a narrowing) keeps them
 * apart.
 */
const readShapeOf = (operation: GetOperation): string => {
  const { result, lineage: _lineage, receiver: _receiver, key: _key, ...rest } = operation
  return `${representationKey(result.representation)}|${JSON.stringify(rest)}`
}

/** What an operation forgets: every read, the reads of one key, the reads through one cell, or nothing. */
export type FieldReadKill =
  { readonly kind: 'all' } | { readonly kind: 'key'; readonly key: string } | { readonly kind: 'cell'; readonly cell: DeclarationId } | null

/**
 * The facts this pass tracks over one body: which reads are candidates, the
 * receiver each one names (a cell for a binding read, else the SSA value), and
 * what every other operation forgets.
 */
export interface FieldReadFacts {
  readonly candidates: ReadonlyMap<GetOperation, { readonly key: string; readonly shape: string }>
  readonly pinned: ReadonlySet<IrValueId>
  readonly receiverOf: (value: IrValueId) => string
  readonly killOf: (operation: IrNonTerminatorOperation) => FieldReadKill
  readonly forgets: (kill: FieldReadKill, fact: { readonly receiver: string; readonly key: string }) => boolean
  readonly factId: (receiver: string, key: string, shape: string) => string
}

export const fieldReadFactsOf = (body: IrBody, codeFree: CodeFreeFieldRead): FieldReadFacts => {
  const keys = stringConstantsOf(body)
  const cells = new Map<IrValueId, DeclarationId>()
  const producers = new Map<IrValueId, IrNonTerminatorOperation>()
  // A standard-prototype absence fact is authenticated by tracing its
  // receiver back to the source operand it was proved for; a reused read
  // traces to the other read's source, so a read such a fact consumes stays.
  //
  // The trace does not stop at the consumer's own operand: it walks back
  // through the transports between the read and the consumer (`a.b?.c` reads
  // `c` off the unwrapped `a.b`, a convert away from the read), so every value
  // on that walk is pinned, not only the first.
  const definitions = new Map<IrValueId, IrNonTerminatorOperation>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, operation)
    }
  const pinned = new Set<IrValueId>()
  const pin = (start: IrValueId): void => {
    let value: IrValueId | undefined = start
    while (value !== undefined && !pinned.has(value)) {
      pinned.add(value)
      const producer = definitions.get(value)
      value =
        producer?.kind === 'convert' || producer?.kind === 'merge-live-arm-rebuild'
          ? producer.source.value
          : producer?.kind === 'proxy-part'
            ? producer.proxy.value
            : undefined
    }
  }
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (
        ((operation.kind === 'get' || operation.kind === 'has-property') && operation.ordinaryObjectPrototypeKeyAbsent === true) ||
        (operation.kind === 'set' && operation.ordinaryObjectDataWriteAbsent === true)
      )
        for (const operand of operandsOfIrOperation(operation)) pin(operand.value)
  const candidates = new Map<GetOperation, { readonly key: string; readonly shape: string }>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      if (operation.kind === 'binding-read') cells.set(operation.result.id, operation.declaration)
      if (operation.kind === 'get') producers.set(operation.result.id, operation)
      if (operation.kind !== 'get' || operation.reactive === true || operation.hostMethod !== undefined) continue
      const key = keys.get(operation.key.value)
      if (key === undefined || !codeFree(operation.receiver.representation, key)) continue
      candidates.set(operation, { key, shape: readShapeOf(operation) })
    }
  const receiverOf = (value: IrValueId): string => {
    const cell = cells.get(value)
    return cell === undefined ? `value:${value}` : `cell:${cell}`
  }
  const all: FieldReadKill = { kind: 'all' }
  const killOf = (operation: IrNonTerminatorOperation): FieldReadKill => {
    switch (operation.kind) {
      case 'constant':
      case 'binding-read':
      case 'parameter':
      case 'receiver':
      case 'phi':
      case 'global-this':
      case 'allocate-ordinary-object':
      case 'allocate-record':
      case 'allocate-callable':
      case 'test':
        return null
      case 'binding-write':
      case 'binding-renew':
        return { kind: 'cell', cell: operation.declaration }
      case 'allocate-array-object':
        return arrayAllocationDrainsDynamicIterator(operation) ? all : null
      case 'compute':
        return operandsOfIrOperation(operation).every((operand) => primitive(operand.representation)) ? null : all
      case 'convert':
        return primitive(operation.source.representation) || !primitive(operation.result.representation) ? null : all
      case 'get':
        return candidates.has(operation) || operation.hostMethod !== undefined || nativeData(operation.receiver.representation) ? null : all
      case 'call': {
        // A host method over data -- `Math.max`, an array's `indexOf` -- runs
        // none of the program's code (`write-effects.ts`).
        const callee = producers.get(operation.callee.value)
        if (operation.closedCallee !== undefined || callee?.kind !== 'get') return all
        const receiver =
          callee.receiver.representation.kind === 'optional' ? callee.receiver.representation.payload : callee.receiver.representation
        const host =
          (callee.hostMethod !== undefined || nativeData(receiver)) && (receiver.kind === 'native-handle' || inertArgument(receiver))
        return host && operation.arguments.every((argument) => inertArgument(argument.representation)) ? null : all
      }
      case 'set':
      case 'define-own-property': {
        const key = keys.get(operation.key.value)
        if (key === undefined) return all
        const receiver = operation.receiver.representation
        return codeFree(receiver.kind === 'optional' ? receiver.payload : receiver, key) ? { kind: 'key', key } : all
      }
      default:
        return all
    }
  }
  const forgets = (kill: FieldReadKill, fact: { readonly receiver: string; readonly key: string }): boolean =>
    kill !== null && (kill.kind === 'all' || (kill.kind === 'key' ? fact.key === kill.key : fact.receiver === `cell:${kill.cell}`))
  const factId = (receiver: string, key: string, shape: string): string => `${receiver}\u0000${key}\u0000${shape}`
  return { candidates, pinned, receiverOf, killOf, forgets, factId }
}

const reusedBody = (body: IrBody, codeFree: CodeFreeFieldRead): IrBody => {
  if (body.tryRegions.length > 0) return body
  const { candidates, pinned, receiverOf, killOf, forgets, factId } = fieldReadFactsOf(body, codeFree)
  if (candidates.size < 2) return body
  const apply = (facts: Map<string, Available>, kill: FieldReadKill): void => {
    if (kill === null) return
    if (kill.kind === 'all') facts.clear()
    else for (const [id, fact] of facts) if (forgets(kill, fact)) facts.delete(id)
  }
  const graph = controlFlowGraphOf(body)
  const predecessorsOf = (block: IrBlockId): readonly IrBlockId[] => [...new Set(graph.predecessors.get(block) ?? [])]
  const values = new Map(body.values)
  let ordinal = 0
  // A join every predecessor reaches with its own read of the same field
  // takes a phi of those reads: one name per join and field, kept across
  // iterations so the walk can settle.
  const phis = new Map<
    string,
    { readonly id: IrValueId; readonly block: IrBlockId; readonly fact: string; readonly lineage: SemanticResultId }
  >()
  const phiOf = (block: IrBlockId, fact: string, available: Available): IrValueId => {
    const name = `${block}\u0000${fact}`
    const existing = phis.get(name)
    if (existing !== undefined) return existing.id
    while (values.has(irValueId(body.owner, ordinal))) ordinal++
    const id = irValueId(body.owner, ordinal++)
    values.set(id, available.representation)
    phis.set(name, { id, block, fact, lineage: available.lineage })
    return id
  }
  const exitFacts = new Map<IrBlockId, Map<string, Available>>()
  const entryFacts = new Map<IrBlockId, Map<string, Available>>()
  const merge = (block: IrBlockId): Map<string, Available> | null => {
    const predecessors = predecessorsOf(block)
    if (block === body.entry || predecessors.length === 0) return new Map()
    // An unreached predecessor is the top of the lattice: a loop header starts
    // from its entry edge and is narrowed once its back edge is reached.
    const reached = predecessors.flatMap((predecessor) => {
      const exit = exitFacts.get(predecessor)
      return exit === undefined ? [] : [exit]
    })
    const [first, ...rest] = reached
    if (first === undefined) return null
    const merged = new Map<string, Available>()
    for (const [fact, available] of first) {
      const others = rest.map((exit) => exit.get(fact))
      if (others.some((other) => other === undefined)) continue
      const same = others.every((other) => other!.value === available.value)
      merged.set(fact, same ? available : { ...available, value: phiOf(block, fact, available) })
    }
    return merged
  }
  const transfer = (block: IrBlock, facts: Map<string, Available>, replaced: Map<IrValueId, IrValueId> | null): Map<string, Available> => {
    for (const operation of block.operations) {
      const candidate = operation.kind === 'get' ? candidates.get(operation) : undefined
      if (candidate !== undefined && operation.kind === 'get') {
        const receiver = receiverOf(operation.receiver.value)
        const id = factId(receiver, candidate.key, candidate.shape)
        const available = facts.get(id)
        if (available !== undefined) {
          if (!pinned.has(operation.result.id)) replaced?.set(operation.result.id, available.value)
        } else
          facts.set(id, {
            receiver,
            key: candidate.key,
            shape: candidate.shape,
            value: operation.result.id,
            representation: operation.result.representation,
            lineage: operation.lineage
          })
        continue
      }
      apply(facts, killOf(operation))
    }
    return facts
  }
  const sameFacts = (left: ReadonlyMap<string, Available>, right: ReadonlyMap<string, Available>): boolean =>
    left.size === right.size && [...left].every(([fact, available]) => right.get(fact)?.value === available.value)
  let settled = false
  for (let round = 0; round < 64 && !settled; round++) {
    settled = true
    for (const id of body.blockOrder) {
      const block = body.blocks.get(id)
      if (block === undefined) continue
      const incoming = merge(id)
      if (incoming === null) continue
      entryFacts.set(id, new Map(incoming))
      const exit = transfer(block, incoming, null)
      const previous = exitFacts.get(id)
      if (previous === undefined || !sameFacts(previous, exit)) {
        exitFacts.set(id, exit)
        settled = false
      }
    }
  }
  if (!settled) return body
  const replaced = new Map<IrValueId, IrValueId>()
  for (const id of body.blockOrder) {
    const block = body.blocks.get(id)
    const entry = entryFacts.get(id)
    if (block !== undefined && entry !== undefined) transfer(block, new Map(entry), replaced)
  }
  if (replaced.size === 0) return body
  // Only the phis some reuse reads, and the phis those read through a back
  // edge or an earlier join, are built.
  const phisById = new Map([...phis.values()].map((phi) => [phi.id, phi]))
  const built = new Map<IrBlockId, PhiOperation[]>()
  const pending = [...new Set(replaced.values())].filter((value) => phisById.has(value))
  const placed = new Set<IrValueId>()
  while (pending.length > 0) {
    const value = pending.pop()!
    if (placed.has(value)) continue
    placed.add(value)
    const phi = phisById.get(value)!
    const representation = values.get(value)!
    const incoming: IrPhiIncoming[] = []
    for (const predecessor of predecessorsOf(phi.block)) {
      const available = exitFacts.get(predecessor)?.get(phi.fact)
      if (available === undefined) return body
      incoming.push({ block: predecessor, value: { value: available.value, representation } })
      if (phisById.has(available.value)) pending.push(available.value)
    }
    const list = built.get(phi.block) ?? []
    list.push({ kind: 'phi', lineage: phi.lineage, incoming, result: { id: value, representation } })
    built.set(phi.block, list)
  }
  for (const phi of phis.values()) if (!placed.has(phi.id)) values.delete(phi.id)
  const blocks = new Map<IrBlockId, IrBlock>()
  for (const [id, block] of body.blocks) {
    const kept = block.operations
      .filter((operation) => !(operation.kind === 'get' && replaced.has(operation.result.id)))
      .map((operation) => renamedNonTerminator(operation, (value) => replaced.get(value) ?? value))
    const leading = kept.findIndex((operation) => operation.kind !== 'phi')
    const split = leading < 0 ? kept.length : leading
    const operations = [...kept.slice(0, split), ...(built.get(id) ?? []), ...kept.slice(split)]
    blocks.set(id, { ...block, operations, terminator: renamedTerminator(block.terminator, (value) => replaced.get(value) ?? value) })
  }
  for (const value of replaced.keys()) values.delete(value)
  const rewritten: IrBody = { ...body, blocks, values }
  for (const block of blocks.values())
    for (const operation of [...block.operations, block.terminator])
      if (operandsOfIrOperation(operation).some((operand) => replaced.has(operand.value))) return body
  return verifyIrBody(rewritten).length === 0 ? rewritten : body
}

/**
 * The operation with every operand naming a replaced read renamed to the read
 * it reuses. An operand is the `{ value, representation }` pair wherever an
 * operation or one of its published facts holds it; a bare `IrValueId` a fact
 * cites (an allocation, a capture) is an identity, not a read, and keeps its
 * name.
 *
 * Spelled per operation kind rather than as one walk over arbitrary objects so
 * a native build can type every step, and so a new operation kind or a new
 * operand-holding fact fails to compile here instead of silently keeping a
 * stale operand. Untouched parts keep their identity: a caller compares the
 * result against the original to learn whether anything moved.
 */
type ValueResolver = (value: IrValueId) => IrValueId

const renamedOperand = (operand: IrOperand, resolve: ValueResolver): IrOperand => {
  const value = resolve(operand.value)
  return value === operand.value ? operand : { ...operand, value }
}

const renamedOptionalOperand = (operand: IrOperand | null, resolve: ValueResolver): IrOperand | null =>
  operand === null ? null : renamedOperand(operand, resolve)

const renamedEach = <E>(items: readonly E[], rename: (item: E) => E): readonly E[] => {
  let copy: E[] | null = null
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    const next = rename(item)
    if (next !== item) (copy ??= items.slice())[index] = next
  }
  return copy ?? items
}

const renamedOperands = (operands: readonly IrOperand[], resolve: ValueResolver): readonly IrOperand[] =>
  renamedEach(operands, (operand) => renamedOperand(operand, resolve))

type ObjectDataSlot = NonNullable<GetOperation['nativeObjectDataSlot']>
const renamedObjectDataSlot = (slot: ObjectDataSlot, resolve: ValueResolver): ObjectDataSlot => {
  let next = slot
  const owner = renamedOperand(slot.owner, resolve)
  if (owner !== slot.owner) next = { ...next, owner }
  if (slot.write !== null) {
    const value = renamedOperand(slot.write.value, resolve)
    if (value !== slot.write.value) next = { ...next, write: { ...slot.write, value } }
  }
  return next
}

type CallableDataSlot = NonNullable<GetOperation['nativeCallableDataSlot']>
const renamedCallableDataSlot = (slot: CallableDataSlot, resolve: ValueResolver): CallableDataSlot => {
  const value = renamedOperand(slot.value, resolve)
  return value === slot.value ? slot : { ...slot, value }
}

type PrivateCallableSlot = NonNullable<GetOperation['privateNativeCallableSlot']>
const renamedPrivateCallableSlot = (slot: PrivateCallableSlot, resolve: ValueResolver): PrivateCallableSlot => {
  const value = renamedOperand(slot.value, resolve)
  return value === slot.value ? slot : { ...slot, value }
}

type CallablePrototype = NonNullable<GetOperation['nativeCallablePrototype']>
const renamedCallablePrototype = (prototype: CallablePrototype, resolve: ValueResolver): CallablePrototype => {
  const receiver = renamedOperand(prototype.receiver, resolve)
  return receiver === prototype.receiver ? prototype : { ...prototype, receiver }
}

type DocumentEntry = NonNullable<GetOperation['nativeDocumentEntry']>
const renamedDocumentEntry = (entry: DocumentEntry, resolve: ValueResolver): DocumentEntry => {
  const receiver = renamedOperand(entry.receiver, resolve)
  return receiver === entry.receiver ? entry : { ...entry, receiver }
}

type CallableDataWrite = NonNullable<SetOperation['nativeCallableDataWrite']>
const renamedCallableDataWrite = (write: CallableDataWrite, resolve: ValueResolver): CallableDataWrite => {
  const receiver = renamedOperand(write.receiver, resolve)
  const key = renamedOperand(write.key, resolve)
  const value = renamedOperand(write.value, resolve)
  const storedValue = renamedOperand(write.storedValue, resolve)
  return receiver === write.receiver && key === write.key && value === write.value && storedValue === write.storedValue
    ? write
    : { ...write, receiver, key, value, storedValue }
}

type CallableReadonlySet = NonNullable<SetOperation['nativeCallableReadonlySet']>
const renamedCallableReadonlySet = (set: CallableReadonlySet, resolve: ValueResolver): CallableReadonlySet => {
  const receiver = renamedOperand(set.receiver, resolve)
  const key = renamedOperand(set.key, resolve)
  const value = renamedOperand(set.value, resolve)
  return receiver === set.receiver && key === set.key && value === set.value ? set : { ...set, receiver, key, value }
}

type ArrayDescriptorSnapshot = NonNullable<CallOperation['nativeArrayDescriptorSnapshot']>
const renamedArrayDescriptorSnapshot = (snapshot: ArrayDescriptorSnapshot, resolve: ValueResolver): ArrayDescriptorSnapshot => {
  const receiver = renamedOperand(snapshot.receiver, resolve)
  const key = renamedOperand(snapshot.key, resolve)
  return receiver === snapshot.receiver && key === snapshot.key ? snapshot : { ...snapshot, receiver, key }
}

type ArrayDescriptorReinstallation = NonNullable<CallOperation['nativeArrayDescriptorReinstallation']>
const renamedArrayDescriptorReinstallation = (
  reinstallation: ArrayDescriptorReinstallation,
  resolve: ValueResolver
): ArrayDescriptorReinstallation => {
  const receiver = renamedOperand(reinstallation.receiver, resolve)
  const key = renamedOperand(reinstallation.key, resolve)
  const descriptor = renamedOperand(reinstallation.descriptor, resolve)
  return receiver === reinstallation.receiver && key === reinstallation.key && descriptor === reinstallation.descriptor
    ? reinstallation
    : { ...reinstallation, receiver, key, descriptor }
}

type CallableIntegrity = NonNullable<CallOperation['nativeCallableIntegrity']>
const renamedCallableIntegrity = (integrity: CallableIntegrity, resolve: ValueResolver): CallableIntegrity => {
  let next = integrity
  const receiver = renamedOperand(integrity.receiver, resolve)
  if (receiver !== integrity.receiver) next = { ...next, receiver }
  if (integrity.prototype !== undefined) {
    const prototype = renamedCallablePrototype(integrity.prototype, resolve)
    if (prototype !== integrity.prototype) next = { ...next, prototype }
  }
  return next
}

type OwnAssignment = NonNullable<CallOperation['nativeOwnAssignment']>
type OwnAssignmentSource = OwnAssignment['sources'][number]
const renamedOwnAssignment = (assignment: OwnAssignment, resolve: ValueResolver): OwnAssignment => {
  const owner = renamedOperand(assignment.owner, resolve)
  const sources = renamedEach(assignment.sources, (source: OwnAssignmentSource): OwnAssignmentSource => {
    const receiver = renamedOperand(source.receiver, resolve)
    return receiver === source.receiver ? source : { ...source, receiver }
  })
  return owner === assignment.owner && sources === assignment.sources ? assignment : { ...assignment, owner, sources }
}

type AccessorReinstallation = NonNullable<CallOperation['nativeAccessorReinstallation']>
const renamedAccessorReinstallation = (reinstallation: AccessorReinstallation, resolve: ValueResolver): AccessorReinstallation => {
  const snapshotReceiver = renamedOperand(reinstallation.snapshotReceiver, resolve)
  const snapshotKey = renamedOperand(reinstallation.snapshotKey, resolve)
  return snapshotReceiver === reinstallation.snapshotReceiver && snapshotKey === reinstallation.snapshotKey
    ? reinstallation
    : { ...reinstallation, snapshotReceiver, snapshotKey }
}

type ObjectSample = NonNullable<ConvertOperation['nativeObjectSample']>
const renamedObjectSample = (sample: ObjectSample, resolve: ValueResolver): ObjectSample => {
  const observed = renamedOperand(sample.observed, resolve)
  const owner = renamedOperand(sample.owner, resolve)
  return observed === sample.observed && owner === sample.owner ? sample : { ...sample, observed, owner }
}

const renamedArrayElement = (element: IrArrayElement, resolve: ValueResolver): IrArrayElement => {
  switch (element.kind) {
    case 'hole':
      return element
    case 'gather': {
      const iterator = renamedOperand(element.iterator, resolve)
      return iterator === element.iterator ? element : { ...element, iterator }
    }
    case 'element': {
      const value = renamedOperand(element.value, resolve)
      return value === element.value ? element : { ...element, value }
    }
    case 'spread': {
      const value = renamedOperand(element.value, resolve)
      return value === element.value ? element : { ...element, value }
    }
  }
}

const renamedGet = (operation: GetOperation, resolve: ValueResolver): GetOperation => {
  let next = operation
  const receiver = renamedOperand(operation.receiver, resolve)
  const key = renamedOperand(operation.key, resolve)
  if (receiver !== operation.receiver || key !== operation.key) next = { ...next, receiver, key }
  if (operation.nativeObjectDataSlot !== undefined) {
    const nativeObjectDataSlot = renamedObjectDataSlot(operation.nativeObjectDataSlot, resolve)
    if (nativeObjectDataSlot !== operation.nativeObjectDataSlot) next = { ...next, nativeObjectDataSlot }
  }
  if (operation.nativeCallableDataSlot !== undefined) {
    const nativeCallableDataSlot = renamedCallableDataSlot(operation.nativeCallableDataSlot, resolve)
    if (nativeCallableDataSlot !== operation.nativeCallableDataSlot) next = { ...next, nativeCallableDataSlot }
  }
  if (operation.privateNativeCallableSlot !== undefined) {
    const privateNativeCallableSlot = renamedPrivateCallableSlot(operation.privateNativeCallableSlot, resolve)
    if (privateNativeCallableSlot !== operation.privateNativeCallableSlot) next = { ...next, privateNativeCallableSlot }
  }
  if (operation.nativeCallablePrototype !== undefined) {
    const nativeCallablePrototype = renamedCallablePrototype(operation.nativeCallablePrototype, resolve)
    if (nativeCallablePrototype !== operation.nativeCallablePrototype) next = { ...next, nativeCallablePrototype }
  }
  if (operation.nativeDocumentEntry !== undefined) {
    const nativeDocumentEntry = renamedDocumentEntry(operation.nativeDocumentEntry, resolve)
    if (nativeDocumentEntry !== operation.nativeDocumentEntry) next = { ...next, nativeDocumentEntry }
  }
  return next
}

const renamedSet = (operation: SetOperation, resolve: ValueResolver): SetOperation => {
  let next = operation
  const receiver = renamedOperand(operation.receiver, resolve)
  const key = renamedOperand(operation.key, resolve)
  const value = renamedOperand(operation.value, resolve)
  if (receiver !== operation.receiver || key !== operation.key || value !== operation.value) next = { ...next, receiver, key, value }
  if (operation.nativeCallableReadonlySet !== undefined) {
    const nativeCallableReadonlySet = renamedCallableReadonlySet(operation.nativeCallableReadonlySet, resolve)
    if (nativeCallableReadonlySet !== operation.nativeCallableReadonlySet) next = { ...next, nativeCallableReadonlySet }
  }
  if (operation.nativeCallableDataWrite !== undefined) {
    const nativeCallableDataWrite = renamedCallableDataWrite(operation.nativeCallableDataWrite, resolve)
    if (nativeCallableDataWrite !== operation.nativeCallableDataWrite) next = { ...next, nativeCallableDataWrite }
  }
  if (operation.nativeObjectDataSlot !== undefined) {
    const nativeObjectDataSlot = renamedObjectDataSlot(operation.nativeObjectDataSlot, resolve)
    if (nativeObjectDataSlot !== operation.nativeObjectDataSlot) next = { ...next, nativeObjectDataSlot }
  }
  if (operation.nativeCallableDataSlot !== undefined) {
    const nativeCallableDataSlot = renamedCallableDataSlot(operation.nativeCallableDataSlot, resolve)
    if (nativeCallableDataSlot !== operation.nativeCallableDataSlot) next = { ...next, nativeCallableDataSlot }
  }
  if (operation.privateNativeCallableSlot !== undefined) {
    const privateNativeCallableSlot = renamedPrivateCallableSlot(operation.privateNativeCallableSlot, resolve)
    if (privateNativeCallableSlot !== operation.privateNativeCallableSlot) next = { ...next, privateNativeCallableSlot }
  }
  if (operation.nativeDocumentEntry !== undefined) {
    const nativeDocumentEntry = renamedDocumentEntry(operation.nativeDocumentEntry, resolve)
    if (nativeDocumentEntry !== operation.nativeDocumentEntry) next = { ...next, nativeDocumentEntry }
  }
  return next
}

const renamedCall = (operation: CallOperation, resolve: ValueResolver): CallOperation => {
  let next = operation
  const callee = renamedOperand(operation.callee, resolve)
  const receiver = renamedOptionalOperand(operation.receiver, resolve)
  const args = renamedOperands(operation.arguments, resolve)
  if (callee !== operation.callee || receiver !== operation.receiver || args !== operation.arguments)
    next = { ...next, callee, receiver, arguments: args }
  if (operation.thisArgument !== undefined) {
    const thisArgument = renamedOperand(operation.thisArgument, resolve)
    if (thisArgument !== operation.thisArgument) next = { ...next, thisArgument }
  }
  if (operation.nativeArrayDescriptorSnapshot !== undefined) {
    const nativeArrayDescriptorSnapshot = renamedArrayDescriptorSnapshot(operation.nativeArrayDescriptorSnapshot, resolve)
    if (nativeArrayDescriptorSnapshot !== operation.nativeArrayDescriptorSnapshot) next = { ...next, nativeArrayDescriptorSnapshot }
  }
  if (operation.nativeArrayDescriptorReinstallation !== undefined) {
    const nativeArrayDescriptorReinstallation = renamedArrayDescriptorReinstallation(operation.nativeArrayDescriptorReinstallation, resolve)
    if (nativeArrayDescriptorReinstallation !== operation.nativeArrayDescriptorReinstallation)
      next = { ...next, nativeArrayDescriptorReinstallation }
  }
  if (operation.nativeCallablePrototypeDescriptor !== undefined) {
    const nativeCallablePrototypeDescriptor = renamedCallablePrototype(operation.nativeCallablePrototypeDescriptor, resolve)
    if (nativeCallablePrototypeDescriptor !== operation.nativeCallablePrototypeDescriptor)
      next = { ...next, nativeCallablePrototypeDescriptor }
  }
  if (operation.nativeCallableIntegrity !== undefined) {
    const nativeCallableIntegrity = renamedCallableIntegrity(operation.nativeCallableIntegrity, resolve)
    if (nativeCallableIntegrity !== operation.nativeCallableIntegrity) next = { ...next, nativeCallableIntegrity }
  }
  if (operation.nativeCallableDataWrite !== undefined) {
    const nativeCallableDataWrite = renamedCallableDataWrite(operation.nativeCallableDataWrite, resolve)
    if (nativeCallableDataWrite !== operation.nativeCallableDataWrite) next = { ...next, nativeCallableDataWrite }
  }
  if (operation.nativeOwnAssignment !== undefined) {
    const nativeOwnAssignment = renamedOwnAssignment(operation.nativeOwnAssignment, resolve)
    if (nativeOwnAssignment !== operation.nativeOwnAssignment) next = { ...next, nativeOwnAssignment }
  }
  if (operation.nativeCallableDataSlot !== undefined) {
    const nativeCallableDataSlot = renamedCallableDataSlot(operation.nativeCallableDataSlot, resolve)
    if (nativeCallableDataSlot !== operation.nativeCallableDataSlot) next = { ...next, nativeCallableDataSlot }
  }
  if (operation.nativeAccessorReinstallation !== undefined) {
    const nativeAccessorReinstallation = renamedAccessorReinstallation(operation.nativeAccessorReinstallation, resolve)
    if (nativeAccessorReinstallation !== operation.nativeAccessorReinstallation) next = { ...next, nativeAccessorReinstallation }
  }
  return next
}

const renamedConvert = (operation: ConvertOperation, resolve: ValueResolver): ConvertOperation => {
  let next = operation
  const source = renamedOperand(operation.source, resolve)
  if (source !== operation.source) next = { ...next, source }
  if (operation.nativeCallablePrototypeObservation !== undefined) {
    const nativeCallablePrototypeObservation = renamedCallablePrototype(operation.nativeCallablePrototypeObservation, resolve)
    if (nativeCallablePrototypeObservation !== operation.nativeCallablePrototypeObservation)
      next = { ...next, nativeCallablePrototypeObservation }
  }
  if (operation.nativeObjectSample !== undefined) {
    const nativeObjectSample = renamedObjectSample(operation.nativeObjectSample, resolve)
    if (nativeObjectSample !== operation.nativeObjectSample) next = { ...next, nativeObjectSample }
  }
  return next
}

const renamedTerminator = (operation: IrTerminatorOperation, resolve: ValueResolver): IrTerminatorOperation => {
  switch (operation.kind) {
    case 'jump':
      return operation
    case 'branch': {
      const condition = renamedOperand(operation.condition, resolve)
      return condition === operation.condition ? operation : { ...operation, condition }
    }
    case 'return': {
      const value = renamedOptionalOperand(operation.value, resolve)
      return value === operation.value ? operation : { ...operation, value }
    }
    case 'throw': {
      const value = renamedOperand(operation.value, resolve)
      return value === operation.value ? operation : { ...operation, value }
    }
    case 'switch': {
      const discriminant = renamedOperand(operation.discriminant, resolve)
      const cases = renamedEach(operation.cases, (entry: IrSwitchCase): IrSwitchCase => {
        const test = renamedOperand(entry.test, resolve)
        return test === entry.test ? entry : { ...entry, test }
      })
      return discriminant === operation.discriminant && cases === operation.cases ? operation : { ...operation, discriminant, cases }
    }
  }
}

const renamedNonTerminator = (operation: IrNonTerminatorOperation, resolve: ValueResolver): IrNonTerminatorOperation => {
  switch (operation.kind) {
    case 'get':
      return renamedGet(operation, resolve)
    case 'set':
      return renamedSet(operation, resolve)
    case 'call':
      return renamedCall(operation, resolve)
    case 'convert':
      return renamedConvert(operation, resolve)
    case 'commonjs-require':
    case 'commonjs-binding':
    case 'constant':
    case 'binding-read':
    case 'binding-renew':
    case 'parameter':
    case 'receiver':
    case 'global-this':
    case 'catch-binding':
    case 'unresolvable-reference':
    case 'allocate-ordinary-object':
    case 'allocate-template-object':
    case 'allocate-regexp':
      return operation
    case 'delete': {
      const receiver = renamedOperand(operation.receiver, resolve)
      const key = renamedOperand(operation.key, resolve)
      return receiver === operation.receiver && key === operation.key ? operation : { ...operation, receiver, key }
    }
    case 'has-property': {
      const receiver = renamedOperand(operation.receiver, resolve)
      const key = renamedOperand(operation.key, resolve)
      return receiver === operation.receiver && key === operation.key ? operation : { ...operation, receiver, key }
    }
    case 'own-property-keys': {
      const receiver = renamedOperand(operation.receiver, resolve)
      return receiver === operation.receiver ? operation : { ...operation, receiver }
    }
    case 'module-namespace': {
      const fresh = renamedOperand(operation.fresh, resolve)
      return fresh === operation.fresh ? operation : { ...operation, fresh }
    }
    case 'define-own-property': {
      const receiver = renamedOperand(operation.receiver, resolve)
      const key = renamedOperand(operation.key, resolve)
      const value = renamedOperand(operation.value, resolve)
      return receiver === operation.receiver && key === operation.key && value === operation.value
        ? operation
        : { ...operation, receiver, key, value }
    }
    case 'spread-copy': {
      const receiver = renamedOperand(operation.receiver, resolve)
      const source = renamedOperand(operation.source, resolve)
      return receiver === operation.receiver && source === operation.source ? operation : { ...operation, receiver, source }
    }
    case 'commonjs-binding-set': {
      const value = renamedOperand(operation.value, resolve)
      return value === operation.value ? operation : { ...operation, value }
    }
    case 'binding-write': {
      const value = renamedOperand(operation.value, resolve)
      return value === operation.value ? operation : { ...operation, value }
    }
    case 'proxy-arm-test': {
      const value = renamedOperand(operation.value, resolve)
      return value === operation.value ? operation : { ...operation, value }
    }
    case 'test': {
      const value = renamedOperand(operation.value, resolve)
      return value === operation.value ? operation : { ...operation, value }
    }
    case 'super-initialize': {
      const args = renamedOperands(operation.arguments, resolve)
      return args === operation.arguments ? operation : { ...operation, arguments: args }
    }
    case 'reparent-constructor': {
      const classValue = renamedOperand(operation.classValue, resolve)
      const heritage = renamedOperand(operation.heritage, resolve)
      return classValue === operation.classValue && heritage === operation.heritage ? operation : { ...operation, classValue, heritage }
    }
    case 'construct': {
      const callee = renamedOperand(operation.callee, resolve)
      const newTarget = renamedOperand(operation.newTarget, resolve)
      const args = renamedOperands(operation.arguments, resolve)
      return callee === operation.callee && newTarget === operation.newTarget && args === operation.arguments
        ? operation
        : { ...operation, callee, newTarget, arguments: args }
    }
    case 'await': {
      const operand = renamedOperand(operation.operand, resolve)
      return operand === operation.operand ? operation : { ...operation, operand }
    }
    case 'yield': {
      const operand = renamedOptionalOperand(operation.operand, resolve)
      return operand === operation.operand ? operation : { ...operation, operand }
    }
    case 'compute': {
      const operands = renamedOperands(operation.operands, resolve)
      return operands === operation.operands ? operation : { ...operation, operands }
    }
    case 'phi': {
      const incoming = renamedEach(operation.incoming, (edge: IrPhiIncoming): IrPhiIncoming => {
        const value = renamedOperand(edge.value, resolve)
        return value === edge.value ? edge : { ...edge, value }
      })
      return incoming === operation.incoming ? operation : { ...operation, incoming }
    }
    case 'allocate-array-object': {
      const elements = renamedEach(operation.elements, (element: IrArrayElement) => renamedArrayElement(element, resolve))
      return elements === operation.elements ? operation : { ...operation, elements }
    }
    case 'allocate-callable': {
      const captures = renamedOperands(operation.captures, resolve)
      return captures === operation.captures ? operation : { ...operation, captures }
    }
    case 'bind-callable': {
      const source = renamedOperand(operation.source, resolve)
      const thisArgument = renamedOptionalOperand(operation.thisArgument, resolve)
      const receiver = renamedOptionalOperand(operation.receiver, resolve)
      const bound = renamedOperands(operation.bound, resolve)
      return source === operation.source &&
        thisArgument === operation.thisArgument &&
        receiver === operation.receiver &&
        bound === operation.bound
        ? operation
        : { ...operation, source, thisArgument, receiver, bound }
    }
    case 'allocate-constructor': {
      let next = operation
      const captures = renamedOperands(operation.captures, resolve)
      if (captures !== operation.captures) next = { ...next, captures }
      if (operation.heritage !== undefined) {
        const heritage = renamedOperand(operation.heritage, resolve)
        if (heritage !== operation.heritage) next = { ...next, heritage }
      }
      return next
    }
    case 'allocate-proxy': {
      const target = renamedOperand(operation.target, resolve)
      const handler = renamedOperand(operation.handler, resolve)
      return target === operation.target && handler === operation.handler ? operation : { ...operation, target, handler }
    }
    case 'proxy-part': {
      const proxy = renamedOperand(operation.proxy, resolve)
      return proxy === operation.proxy ? operation : { ...operation, proxy }
    }
    case 'proxy-trap-check': {
      const answer = renamedOperand(operation.answer, resolve)
      return answer === operation.answer ? operation : { ...operation, answer }
    }
    case 'allocate-record': {
      const fields = renamedEach(operation.fields, (field: IrRecordFieldInit): IrRecordFieldInit => {
        const value = renamedOperand(field.value, resolve)
        return value === field.value ? field : { ...field, value }
      })
      return fields === operation.fields ? operation : { ...operation, fields }
    }
    case 'merge-live-arm-rebuild': {
      const source = renamedOperand(operation.source, resolve)
      return source === operation.source ? operation : { ...operation, source }
    }
    case 'dead-logical-merge-value': {
      const source = renamedOperand(operation.source, resolve)
      return source === operation.source ? operation : { ...operation, source }
    }
    case 'get-iterator': {
      const receiver = renamedOperand(operation.receiver, resolve)
      const method = renamedOptionalOperand(operation.method, resolve)
      return receiver === operation.receiver && method === operation.method ? operation : { ...operation, receiver, method }
    }
    case 'iterator-next': {
      const iterator = renamedOperand(operation.iterator, resolve)
      const value = renamedOptionalOperand(operation.value, resolve)
      return iterator === operation.iterator && value === operation.value ? operation : { ...operation, iterator, value }
    }
    case 'iterator-done': {
      const iterator = renamedOperand(operation.iterator, resolve)
      return iterator === operation.iterator ? operation : { ...operation, iterator }
    }
    case 'iterator-close': {
      const iterator = renamedOperand(operation.iterator, resolve)
      return iterator === operation.iterator ? operation : { ...operation, iterator }
    }
    case 'element': {
      const tag = renamedOptionalOperand(operation.tag, resolve)
      return tag === operation.tag ? operation : { ...operation, tag }
    }
    case 'element-prop': {
      const node = renamedOperand(operation.node, resolve)
      const key = renamedOperand(operation.key, resolve)
      const value = renamedOperand(operation.value, resolve)
      return node === operation.node && key === operation.key && value === operation.value ? operation : { ...operation, node, key, value }
    }
    case 'element-child': {
      const node = renamedOperand(operation.node, resolve)
      const child = renamedOperand(operation.child, resolve)
      return node === operation.node && child === operation.child ? operation : { ...operation, node, child }
    }
  }
}
