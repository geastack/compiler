import type { DeclarationId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import { representationKey, type Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import type {
  AllocateArrayObjectOperation,
  CallOperation,
  ComputeOperation,
  ConstructOperation,
  IrBody,
  IrNonTerminatorOperation,
  IrOperand
} from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * A fresh Set built from an array literal whose only use is `.has()` is a
 * membership test over the literal's elements, and is rewritten into one.
 *
 * A validator running
 * `const VALID_MODES = new Set([PRIMARY, ..., null]); return VALID_MODES.has(mode)`
 * on every call is the case. Built for real that is an array, its element
 * vector, a Set, its item vector and a heap copy of every element string that
 * does not fit the small-string buffer -- a dozen allocations per operation to
 * answer one comparison chain. Nothing about the Set is observable when nothing
 * but `has` ever sees it: `new Set(iterable)` over a native array and
 * `Set.prototype.has` are the intrinsic algorithms the emitter already spells
 * directly (`setFromArray`, `->has`), so the answer is exactly SameValueZero
 * against each element, and the elements are evaluated where the literal was --
 * they are SSA values defined before the allocation, and stay so.
 *
 * The rewrite fires only when the whole chain is closed: the array feeds this
 * one construction and nothing else, every element is a plain element (no
 * hole, spread or drained iterator), the array's element carrier is the Set's
 * key carrier (the `setFromArray` condition), and every read of the Set is a
 * `has` member read whose result is used only as the callee of a one-argument
 * call on that same Set. The Set may pass through one local binding on the
 * way -- the `const` above -- when that binding is written exactly once, here,
 * and no other body reads or writes it (a closure reading it would see a Set).
 * Any other use -- a store elsewhere, a return, a merge, a mutation, `size` --
 * keeps the real Set.
 */
export const rewriteLiteralSetMembership = (bodies: ReadonlyMap<PhysicalBodyId, IrBody>): ReadonlyMap<PhysicalBodyId, IrBody> => {
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
    const rewritten = rewriteBody(body, (declaration) => bodyLocal(declaration, id))
    if (rewritten === body) continue
    output ??= new Map(bodies)
    output.set(id, rewritten)
  }
  return output ?? bodies
}

/** Producers that neither write nor run program code, removable once nothing reads them. */
const sweepableKinds: ReadonlySet<IrNonTerminatorOperation['kind']> = new Set(['constant', 'convert', 'binding-read'])

const bindingDeclarationOf = (operation: IrNonTerminatorOperation): DeclarationId | null =>
  operation.kind === 'binding-read' || operation.kind === 'binding-write' || operation.kind === 'binding-renew'
    ? operation.declaration
    : null

interface Membership {
  /** Every operation the Set and its array occupied, removed whole. */
  readonly removed: readonly IrNonTerminatorOperation[]
  readonly calls: readonly CallOperation[]
  readonly array: AllocateArrayObjectOperation
}

interface BodyIndex {
  readonly producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>
  readonly uses: ReadonlyMap<IrValueId, readonly IrNonTerminatorOperation[]>
  /** Values a terminator or an iterator-close region names: uses no `has` call accounts for. */
  readonly escaping: ReadonlySet<IrValueId>
  readonly bindings: ReadonlyMap<DeclarationId, readonly IrNonTerminatorOperation[]>
  readonly strings: ReadonlyMap<IrValueId, string>
  readonly bodyLocal: (declaration: DeclarationId) => boolean
}

const rewriteBody = (body: IrBody, bodyLocal: (declaration: DeclarationId) => boolean): IrBody => {
  const producers = new Map<IrValueId, IrNonTerminatorOperation>()
  const uses = new Map<IrValueId, IrNonTerminatorOperation[]>()
  const bindings = new Map<DeclarationId, IrNonTerminatorOperation[]>()
  const escaping = new Set<IrValueId>()
  const constructs: ConstructOperation[] = []
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result !== null) producers.set(result.id, operation)
      if (operation.kind === 'construct') constructs.push(operation)
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
  for (const region of body.iteratorCloseRegions ?? []) escaping.add(region.iterator.value)
  if (constructs.length === 0) return body
  const index: BodyIndex = { producers, uses, escaping, bindings, strings: stringConstantsOf(body), bodyLocal }
  const found = constructs.flatMap((construct) => membershipOf(construct, index) ?? [])
  if (found.length === 0) return body
  const removed = new Set<IrNonTerminatorOperation>()
  const replaced = new Map<IrNonTerminatorOperation, ComputeOperation>()
  for (const { removed: occupied, calls, array } of found) {
    for (const operation of occupied) removed.add(operation)
    const candidates = array.elements.flatMap((element) =>
      element.kind === 'element' ? [candidateOf(element.value, producers, body)] : []
    )
    for (const call of calls) {
      const subject = call.arguments[0]
      if (subject === undefined || call.result === null) continue
      replaced.set(call, {
        kind: 'compute',
        lineage: call.lineage,
        form: 'same-value-zero-member',
        operator: 'has',
        operands: [subject, ...candidates],
        result: call.result
      })
    }
  }
  // What fed only the removed operations -- the `"has"` key literal, a
  // widening `convert` an element was read through -- goes with them. Left
  // behind, a dead statement between an element's read and the comparison
  // now using it would split the deferral window (`ir/deferral.ts`) and keep
  // a copy of the element the rewrite exists to avoid.
  // `uses` predates the comparisons, so what they read is kept by name.
  const kept = new Set([...replaced.values()].flatMap((compute) => compute.operands.map((operand) => operand.value)))
  for (let changed = true; changed;) {
    changed = false
    for (const [value, producer] of producers) {
      if (removed.has(producer) || kept.has(value) || escaping.has(value) || !sweepableKinds.has(producer.kind)) continue
      const readers = uses.get(value) ?? []
      if (readers.length === 0 || !readers.every((reader) => removed.has(reader))) continue
      removed.add(producer)
      changed = true
    }
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
  return { ...body, blocks, values }
}

/**
 * An element stated in the carrier it already has, not the array's: the
 * comparison reads it in place, where the literal would have copied it into
 * the key carrier first. A present value widened into an optional key
 * (`string` into `string | null`) is read before the widening -- the
 * comparison against a payload is the present arm's, and the `convert` is
 * left with no reader.
 */
const candidateOf = (element: IrOperand, producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>, body: IrBody): IrOperand => {
  const held = body.values.get(element.value) ?? element.representation
  const producer = producers.get(element.value)
  if (
    producer?.kind === 'convert' &&
    producer.presence === undefined &&
    producer.rebuild === undefined &&
    held.kind === 'optional' &&
    representationKey(producer.source.representation) === representationKey(held.payload)
  )
    return producer.source
  return { value: element.value, representation: held }
}

const membershipOf = (construct: ConstructOperation, index: BodyIndex): Membership | null => {
  const { producers, uses, escaping, bindings, strings } = index
  const set = construct.result.representation
  if (set.kind !== 'keyed-collection' || set.family !== 'set' || set.ownership !== 'shared-refcount') return null
  const source = construct.arguments.length === 1 ? construct.arguments[0] : undefined
  if (source === undefined || source.representation.kind !== 'array-object') return null
  if (representationKey(source.representation.element) !== representationKey(set.key)) return null
  const array = producers.get(source.value)
  if (array?.kind !== 'allocate-array-object') return null
  if (!array.elements.every((element) => element.kind === 'element')) return null
  if (escaping.has(array.result.id) || (uses.get(array.result.id) ?? []).some((use) => use !== construct)) return null
  if (construct.callee.value === array.result.id || construct.newTarget.value === array.result.id) return null

  const removed: IrNonTerminatorOperation[] = [array, construct]
  // The values that ARE this Set: the construction's own result, and every
  // read of the one local binding it is stored into, when it is stored.
  const aliases = new Set<IrValueId>([construct.result.id])
  const direct = uses.get(construct.result.id) ?? []
  const store = direct.length === 1 && direct[0]?.kind === 'binding-write' ? direct[0] : null
  if (store !== null) {
    if (store.value.value !== construct.result.id || !index.bodyLocal(store.declaration)) return null
    for (const operation of bindings.get(store.declaration) ?? []) {
      if (operation === store) continue
      if (operation.kind !== 'binding-read') return null
      aliases.add(operation.result.id)
      removed.push(operation)
    }
    removed.push(store)
  }

  const calls: CallOperation[] = []
  let reads = 0
  for (const alias of aliases) {
    if (escaping.has(alias)) return null
    for (const use of uses.get(alias) ?? []) {
      if (use === store) continue
      if (use.kind === 'call') {
        // Tallied against the `has` calls that name their receiver: a call
        // reading the Set any other way breaks the count.
        reads += 1
        continue
      }
      if (use.kind !== 'get' || !aliases.has(use.receiver.value) || aliases.has(use.key.value)) return null
      if (strings.get(use.key.value) !== 'has') return null
      const method = use.result.id
      if (escaping.has(method)) return null
      const methodUses = uses.get(method) ?? []
      const call = methodUses[0]
      if (methodUses.length !== 1 || call?.kind !== 'call' || !isMembershipCall(call, method, aliases, set.key)) return null
      removed.push(use)
      calls.push(call)
    }
  }
  if (reads !== calls.filter((call) => call.receiver !== null).length || new Set(calls).size !== calls.length) return null
  return { removed, calls, array }
}

const isMembershipCall = (call: CallOperation, method: IrValueId, aliases: ReadonlySet<IrValueId>, key: Representation): boolean => {
  const subject = call.arguments[0]
  return (
    call.callee.value === method &&
    call.callee.representation.kind !== 'optional' &&
    call.callee.representation.kind !== 'dynamic' &&
    // The member read carries the receiver for a method call (`emit.ts`
    // stashes it); a call that also names it must name this same Set.
    (call.receiver === null || aliases.has(call.receiver.value)) &&
    call.arguments.length === 1 &&
    subject !== undefined &&
    !aliases.has(subject.value) &&
    // The key carrier, or a present subject asked of an optional-keyed Set
    // (`VALID_MODES.has(mode as Mode)` with `null` among the modes): the
    // widening into the key is the emitter's, and SameValueZero of a present
    // value against the absent element is simply false.
    (representationKey(subject.representation) === representationKey(key) ||
      (key.kind === 'optional' && representationKey(subject.representation) === representationKey(key.payload))) &&
    call.result?.representation.kind === 'scalar' &&
    call.result.representation.domain === 'boolean' &&
    call.argumentsAreSpread !== true &&
    call.closedFrame === undefined &&
    call.hostTemplate === undefined
  )
}
