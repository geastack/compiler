import { irValueId, type DeclarationId, type IrValueId, type PhysicalBodyId, type SemanticResultId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classFamilyOverridesOf } from '../projection/dispatch.js'
import { classMemberOf, recordAccessorsOfShape, recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import { controlFlowGraphOf } from './dominance.js'
import type { GetOperation, IrBlock, IrBlockId, IrBody, IrNonTerminatorOperation, IrPhiIncoming, PhiOperation } from './model.js'
import { arrayAllocationDrainsDynamicIterator, operandsOfIrOperation } from './queries.js'
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
  const accessorKeys = accessorKeysOf(bodies, classes, deriver)
  const codeFree = (receiver: Representation, key: string): boolean => {
    if (accessorKeys.has(key)) return false
    if (receiver.kind === 'class-ref') {
      if (classes.get(receiver.declaration)?.nativeBase !== null) return false
      return (
        classMemberOf(classes, receiver.declaration, key)?.kind === 'field' &&
        classFamilyOverridesOf(classes, receiver.declaration, key).length === 0
      )
    }
    if (receiver.kind === 'record') return receiver.fields.some((field) => field.key === key)
    if (receiver.kind === 'native-record-ref' && receiver.native === null)
      return recordFieldsOfShape(deriver, receiver.shapeId)?.some((field) => field.key === key) ?? false
    return false
  }
  let output: Map<PhysicalBodyId, IrBody> | null = null
  for (const [id, body] of bodies) {
    const reused = reusedBody(body, codeFree)
    if (reused === body) continue
    output ??= new Map(bodies)
    output.set(id, reused)
  }
  return output ?? bodies
}

/**
 * Every key some getter or setter answers: a class accessor, or an accessor
 * of a record shape a value of the program is carried as. A record viewed as
 * another shape reads through its origin, so a field of the viewed shape can
 * still be answered by a getter of the shape it came from.
 */
const accessorKeysOf = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
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
  for (const body of bodies.values()) for (const representation of body.values.values()) visit(representation)
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

const reusedBody = (body: IrBody, codeFree: (receiver: Representation, key: string) => boolean): IrBody => {
  if (body.tryRegions.length > 0) return body
  const keys = stringConstantsOf(body)
  const cells = new Map<IrValueId, DeclarationId>()
  const producers = new Map<IrValueId, IrNonTerminatorOperation>()
  // A standard-prototype absence fact is authenticated by tracing its
  // receiver back to the source operand it was proved for; a reused read
  // traces to the other read's source, so a read such a fact consumes stays.
  const pinned = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (
        ((operation.kind === 'get' || operation.kind === 'has-property') && operation.ordinaryObjectPrototypeKeyAbsent === true) ||
        (operation.kind === 'set' && operation.ordinaryObjectDataWriteAbsent === true)
      )
        for (const operand of operandsOfIrOperation(operation)) pinned.add(operand.value)
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
  if (candidates.size < 2) return body
  const receiverOf = (value: IrValueId): string => {
    const cell = cells.get(value)
    return cell === undefined ? `value:${value}` : `cell:${cell}`
  }
  // What an operation forgets: every read, the reads of one key, the reads
  // through one cell, or nothing.
  type Kill =
    | { readonly kind: 'all' }
    | { readonly kind: 'key'; readonly key: string }
    | { readonly kind: 'cell'; readonly cell: DeclarationId }
    | null
  const all: Kill = { kind: 'all' }
  const killOf = (operation: IrNonTerminatorOperation): Kill => {
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
  const apply = (facts: Map<string, Available>, kill: Kill): void => {
    if (kill === null) return
    if (kill.kind === 'all') facts.clear()
    else
      for (const [id, fact] of facts)
        if (kill.kind === 'key' ? fact.key === kill.key : fact.receiver === `cell:${kill.cell}`) facts.delete(id)
  }
  const factId = (receiver: string, key: string, shape: string): string => `${receiver}\u0000${key}\u0000${shape}`
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
      .map((operation) => renamed(operation, (value) => replaced.get(value) ?? value))
    const leading = kept.findIndex((operation) => operation.kind !== 'phi')
    const split = leading < 0 ? kept.length : leading
    const operations = [...kept.slice(0, split), ...(built.get(id) ?? []), ...kept.slice(split)]
    blocks.set(id, { ...block, operations, terminator: renamed(block.terminator, (value) => replaced.get(value) ?? value) })
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
 * operation or one of its published facts holds it.
 */
const renamed = <T>(node: T, resolve: (value: IrValueId) => IrValueId): T => {
  if (Array.isArray(node)) {
    let copy: unknown[] | null = null
    node.forEach((item, index) => {
      const next = renamed(item, resolve)
      if (next !== item) (copy ??= [...node])[index] = next
    })
    return (copy ?? node) as T
  }
  if (node === null || typeof node !== 'object' || Object.getPrototypeOf(node) !== Object.prototype) return node
  const record = node as Record<string, unknown>
  let copy: Record<string, unknown> | null = null
  for (const [field, value] of Object.entries(record)) {
    let next = renamed(value, resolve)
    if (field === 'value' && typeof value === 'string' && 'representation' in record) next = resolve(value as IrValueId)
    if (next !== value) (copy ??= { ...record })[field] = next
  }
  return (copy ?? node) as T
}
