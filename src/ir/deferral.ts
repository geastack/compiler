import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type {
  BindingReadOperation,
  BindingWriteOperation,
  CallOperation,
  ConstructOperation,
  GetOperation,
  IrBlockId,
  IrBody,
  IrNonTerminatorOperation,
  IrOperand,
  IrTerminatorOperation,
  ReturnOperation,
  SetOperation
} from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Which values render at their use instead of into a temporary of their own.
 *
 * A value with exactly one use, produced by an operation whose whole emitted
 * form is one side-effect-free expression, does not need storage: the text can
 * stand where the use stands. It lives here, beside the loop censuses, because
 * it is a question about the IR -- what an operation reads and how many places
 * read its result -- and not about C++.
 */
/**
 * The operation kinds whose emitted statement is a side-effect-free
 * expression.
 *
 * Not "cheap" and not "small": the question is whether moving the statement
 * later, past other statements this census has also withheld, could be
 * observed. A read of a cell, a formal, a literal, an arithmetic result, a
 * conversion and a fresh Array are all answers about state nothing in the
 * window changes. Every kind that writes -- `binding-write`, `set`,
 * `define-own-property`, `delete` -- and every kind that can run a program's
 * own code -- `call`, `construct`, `await`, `yield`, the iterator protocol,
 * the JSX element builders -- is absent, so no deferred read is ever moved
 * across an effect.
 *
 * `get` is the one kind decided per operation rather than by name, because it
 * spells two different things: an index or `length` read off an Array or a
 * string is a pure load, and a member read off anything else may reach a
 * program-defined accessor. The narrow answer is the conservative one -- a
 * receiver this census cannot prove pure simply keeps its temporary, which
 * costs a copy and never correctness.
 */
const deferrableOperationKinds: ReadonlySet<IrNonTerminatorOperation['kind']> = new Set([
  'constant',
  'binding-read',
  'parameter',
  'receiver',
  'compute',
  'test',
  'convert',
  'has-property',
  'allocate-array-object'
])

/**
 * The producers WITH effects whose result may still render inside the one
 * operation that immediately consumes it.
 *
 * A call's result is an SSA temporary like any other, and where its single
 * reader is the very next operation there is no window at all: nothing is
 * crossed, so the call runs exactly where the IR placed it and only the
 * temporary disappears. That temporary is not free the way a `double` is.
 * `fns[slot] = makeKind(i % 4, i)` built a 32-byte `CallableObject` into a
 * function-scope local, then copied it into the array cell -- two retains,
 * two releases, and a store-forwarding stall on the 16-byte reload of what
 * two 8-byte stores had just written. Rendered as the store's right-hand side
 * the value is move-assigned straight from the call's return slot: the
 * `closure` fixture went from 104 to 63 instructions per iteration.
 *
 * Unlike a pure deferral the producer is NOT marked withheld, so it goes on
 * bounding every other value's window: a read defined before the call and
 * used after it keeps its temporary, exactly as it does today, and C++'s
 * unspecified operand order inside the consumer can never reorder it across
 * the call.
 */
const forwardableProducerKinds: ReadonlySet<IrNonTerminatorOperation['kind']> = new Set(['call', 'construct', 'allocate-callable'])

/**
 * The consumers a forwarded call may land in. Every one of them is audited to
 * spell the forwarded operand ONCE per executed path -- an operand a renderer
 * spells twice would run the call twice -- and the target's policy narrows
 * each further to the renderings it can vouch for (`ForwardingPolicy`).
 */
export type CallSink = CallOperation | ConstructOperation | SetOperation | BindingWriteOperation | ReturnOperation

/**
 * What only the target can answer about a forwarding: which of its renderers
 * spell an operand exactly once, and which cells are private enough to lose.
 */
export interface ForwardingPolicy {
  /**
   * Whether the target's rendering of `consumer` spells `value` exactly once
   * on every path, with no conversion that could spell it again. The census
   * has already established that `value` is the consumer's argument, stored
   * element, written value or returned value, that nothing sits between the
   * two, and -- for an Array element store -- that the element carrier is the
   * value's own.
   */
  readonly forwardsCallInto: (consumer: CallSink, value: IrOperand) => boolean
  /**
   * Whether `write`'s cell is a private local of this body -- unboxed,
   * captured by nothing, holding exactly the carrier both the write and
   * `read` carry -- so that the one write may render nothing and the one
   * read may spell the written value. Integer-narrowed and type-query cells
   * are excluded by the census itself, which owns both of those facts.
   */
  readonly forwardsBinding: (write: BindingWriteOperation, read: BindingReadOperation) => boolean
}

export const noForwarding: ForwardingPolicy = { forwardsCallInto: () => false, forwardsBinding: () => false }

/** A cell whose one write renders nothing and whose one read spells `value` instead: see `deferrableValuesOf`. */
export interface ForwardedBinding {
  readonly value: IrOperand
  readonly read: IrValueId
}

/**
 * The positions a forwarded call result may occupy in its consumer, decided
 * from the IR alone. An Array element store is admitted only for a stored
 * value already carried as the element's own type: the renderer aligns any
 * other value to the element first, and an alignment is a conversion whose
 * spelling this census does not see.
 */
const callSinkOf = (
  consumer: IrNonTerminatorOperation | IrTerminatorOperation,
  value: IrValueId
): { sink: CallSink; operand: IrOperand } | null => {
  switch (consumer.kind) {
    case 'call':
    case 'construct': {
      const operand = consumer.arguments.find((argument) => argument.value === value)
      return operand === undefined ? null : { sink: consumer, operand }
    }
    case 'set': {
      if (consumer.value.value !== value || consumer.typedComputedWrite !== undefined) return null
      const receiver = consumer.receiver.representation
      if (receiver.kind !== 'array-object' || consumer.key.representation.kind !== 'scalar') return null
      if (representationKey(receiver.element) !== representationKey(consumer.value.representation)) return null
      return { sink: consumer, operand: consumer.value }
    }
    case 'binding-write':
      return consumer.value.value === value ? { sink: consumer, operand: consumer.value } : null
    case 'return':
      return consumer.value !== null && consumer.value.value === value ? { sink: consumer, operand: consumer.value } : null
    default:
      return null
  }
}

/** The carriers `gea::CallableObject` physically holds, whose every call path retains the environment it runs. */
const callableObjectCarrierKinds: ReadonlySet<Representation['kind']> = new Set([
  'function',
  'function-value-dispatch',
  'function-and-constructor'
])

/**
 * Where a forwarded binding's one read may be consumed.
 *
 * The read no longer copies out of a cell that holds its own count, so a
 * consumer that BORROWS the value for the duration of a call -- a receiver
 * or argument passed by reference -- would borrow the array slot or field the
 * written expression names, and the callee may overwrite that slot while the
 * reference is live. Every admitted position either copies the value (a
 * store, a return, a cell write), reads it before anything else runs (an
 * arithmetic operand, a plain member load) or is the CALLEE of a call, where
 * `CallableObject::call` retains the environment it is about to run for
 * exactly this reason.
 */
const forwardedReadPositionAllowed = (
  consumer: IrNonTerminatorOperation | IrTerminatorOperation,
  read: IrValueId,
  representation: Representation,
  pureGet: (operation: GetOperation) => boolean
): boolean => {
  switch (consumer.kind) {
    case 'call':
      return consumer.callee.value === read && callableObjectCarrierKinds.has(representation.kind)
    case 'compute':
    case 'test':
    case 'binding-write':
    case 'return':
      return true
    case 'get': {
      if (consumer.key.value === read) return true
      if (consumer.receiver.value !== read) return false
      const receiver = consumer.receiver.representation.kind
      return receiver === 'array-object' || receiver === 'string' || pureGet(consumer)
    }
    case 'set':
      return consumer.key.value === read || consumer.value.value === read
    default:
      return false
  }
}

/** A conversion over alternatives can inspect its input once per arm. */
const carriesAlternatives = (representation: Representation): boolean => {
  if (representation.kind === 'optional') return carriesAlternatives(representation.payload)
  if (representation.kind === 'borrowed-ref') return carriesAlternatives(representation.referent)
  return representation.kind === 'tagged-union'
}

const isDeferrableOperation = (operation: IrNonTerminatorOperation, pureGet: (operation: GetOperation) => boolean): boolean => {
  // One IR consumer is not necessarily one rendered evaluation. Sum
  // projections may inspect several tags and rebuild a different set of
  // alternatives; substituting one into another multiplies their expression
  // trees. Preserve the SSA temporary at these boundaries, rather than making
  // the target rediscover an expression-size limit after expanding the text.
  if (
    operation.kind === 'convert' &&
    (carriesAlternatives(operation.source.representation) || carriesAlternatives(operation.result.representation))
  )
    return false
  if (operation.kind === 'get') {
    const receiver = operation.receiver.representation.kind
    return receiver === 'array-object' || receiver === 'string' || pureGet(operation)
  }
  return deferrableOperationKinds.has(operation.kind)
}

/**
 * Which values may render at their single use instead of into a temporary of
 * their own.
 *
 * The IR is three-address form, and for a `double` that costs nothing: the C++
 * compiler propagates the copy away. For a `std::shared_ptr` it is an atomic
 * increment and a matching decrement, and for a `std::string` it is a heap
 * allocation -- neither of which any optimizer may remove, because both are
 * observable through the refcount and the allocator. An array indexed in a
 * loop was paying one atomic pair per iteration purely to name the array the
 * cell was already holding.
 *
 * Four conditions, and each one is load-bearing. Compound sum conversions
 * additionally retain their named result to bound composition of projections:
 *
 * 1. exactly one use, so the expression is not evaluated twice;
 * 2. that use in the same block, so no `goto` can reach the use without
 *    passing the definition;
 * 3. the defining operation side-effect-free (`isDeferrableOperation`); and
 * 4. every operation between the two also deferred.
 *
 * (4) is what makes (3) sufficient. Everything between the definition and the
 * use emitted no statement of its own, so the window contains no write at all
 * -- which is why the order these reads end up in inside the use's own
 * expression, which C++ leaves unspecified for most operators, cannot be
 * observed by the program.
 *
 * Two forwardings ride on the same census, each with a narrower proof:
 *
 * - a `call`, `construct` or `allocate-callable` result whose single reader
 *   is the IMMEDIATELY following operation (`forwardableProducerKinds`,
 *   `callSinkOf`): no window, so nothing is crossed, and the producer keeps
 *   bounding everyone else's windows;
 * - a cell written once and read once in one block, the read itself
 *   deferrable, every operation between the two effect-free, and the read
 *   consumed where it is copied or called rather than borrowed
 *   (`forwardedReadPositionAllowed`): the write renders nothing and the read
 *   spells the written value (`forwardedBindings`).
 *
 * The target's `ForwardingPolicy` has the last word on both, because both
 * depend on how a renderer spells its operand and on whose storage a cell is.
 *
 * A use recorded for a merge (`phi`) belongs to the PREDECESSOR block at the
 * position `emitBody` writes merges at -- after that block's operations and
 * before its terminator -- not to the block the phi is written in. Recording
 * it where the phi sits would let a value move across the whole block.
 */
/**
 * `pureGet` widens the `get` rule past Arrays and strings to whatever the
 * emitter can prove is a plain field load (`emit-properties.ts`'s
 * `isPlainMemberRead`): `v20 = gea_this->cities; if (b0 < v20->length())`
 * is a `Ref` copy -- an atomic pair -- made only to name the field once, and
 * with the read deferred the comparison spells the field itself. The default
 * refuses every such read, which is the answer the census gave before it was
 * asked.
 */
export const deferrableValuesOf = (
  body: IrBody,
  pureGet: (operation: GetOperation) => boolean = () => false,
  forwarding: ForwardingPolicy = noForwarding
): {
  readonly values: Set<IrValueId>
  readonly consumedByCall: Set<IrValueId>
  readonly forwardedBindings: Map<DeclarationId, ForwardedBinding>
} => {
  const uses = new Map<IrValueId, { block: IrBlockId; index: number }[]>()
  const record = (value: IrValueId, block: IrBlockId, index: number): void => {
    const sites = uses.get(value)
    if (sites) sites.push({ block, index })
    else uses.set(value, [{ block, index }])
  }
  // A block that writes merges renders statements between its last operation
  // and its terminator, so a call there is not adjacent to a `return` after it.
  const mergeBlocks = new Set<IrBlockId>()
  const producers = new Map<IrValueId, IrNonTerminatorOperation>()
  const bindingWriteCounts = new Map<DeclarationId, number>()
  const bindingReads = new Map<DeclarationId, { block: IrBlockId; index: number; operation: BindingReadOperation }[]>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    block.operations.forEach((operation, index) => {
      if (operation.kind === 'phi') {
        for (const edge of operation.incoming) {
          mergeBlocks.add(edge.block)
          record(edge.value.value, edge.block, body.blocks.get(edge.block)?.operations.length ?? 0)
        }
        return
      }
      const result = resultOfIrOperation(operation)
      if (result !== null) producers.set(result.id, operation)
      if (operation.kind === 'binding-write')
        bindingWriteCounts.set(operation.declaration, (bindingWriteCounts.get(operation.declaration) ?? 0) + 1)
      if (operation.kind === 'binding-read') {
        const reads = bindingReads.get(operation.declaration)
        const site = { block: blockId, index, operation }
        if (reads) reads.push(site)
        else bindingReads.set(operation.declaration, [site])
      }
      for (const operand of operandsOfIrOperation(operation)) record(operand.value, blockId, index)
    })
    for (const operand of operandsOfIrOperation(block.terminator)) record(operand.value, blockId, block.operations.length + 1)
  }
  for (const region of body.iteratorCloseRegions ?? []) record(region.iterator.value, region.entry, 0)
  const deferrable = new Set<IrValueId>()
  const forwardedBindings = new Map<DeclarationId, ForwardedBinding>()
  // A candidate is complete only once the whole body is censused: whether the
  // written value itself defers is decided at its producer, which the
  // descending walk reaches AFTER the write that reads it.
  const bindingCandidates: { declaration: DeclarationId; value: IrOperand; read: IrValueId; write: number; readAt: number; use: number }[] =
    []
  // Which withheld values a CALL is the single reader of. An array literal
  // withheld whole has no statement to move -- it materializes from its own
  // elements wherever its text lands (`EmitContext.pendingPacks`) -- so a
  // renderer that spells one operand twice would build two objects where the
  // program wrote one. Every renderer that does spell an operand twice spells
  // its RECEIVER, and a call argument is never that, so restricting the
  // withholding to call arguments is what makes the one-object rule hold
  // without asking each renderer to promise it.
  const consumedByCall = new Set<IrValueId>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    // Descending, because whether an operation may be deferred depends on
    // whether every LATER operation up to its use already was.
    const withheld = new Set<number>()
    for (let index = block.operations.length - 1; index >= 0; index -= 1) {
      const operation = block.operations[index]
      if (!operation) continue
      // A merge publishes its name before any block renders and emits no
      // statement where it is written, so it never breaks a window.
      if (operation.kind === 'phi') {
        withheld.add(index)
        continue
      }
      if (forwardableProducerKinds.has(operation.kind)) {
        const result = resultOfIrOperation(operation)
        const sites = result === null ? undefined : uses.get(result.id)
        const site = sites?.length === 1 ? sites[0] : undefined
        if (result === null || !site || site.block !== blockId) continue
        // Adjacent means the next operation, or the terminator of a block
        // that writes no merges in front of it.
        const consumer =
          site.index === index + 1 && site.index < block.operations.length
            ? block.operations[site.index]
            : index === block.operations.length - 1 && site.index === block.operations.length + 1 && !mergeBlocks.has(blockId)
              ? block.terminator
              : undefined
        if (consumer === undefined) continue
        const sink = callSinkOf(consumer, result.id)
        if (sink === null || !forwarding.forwardsCallInto(sink.sink, sink.operand)) continue
        deferrable.add(result.id)
        continue
      }
      if (operation.kind === 'binding-write') {
        if (bindingWriteCounts.get(operation.declaration) !== 1) continue
        const reads = bindingReads.get(operation.declaration)
        const read = reads?.length === 1 ? reads[0] : undefined
        if (!read || read.block !== blockId || read.index <= index || !deferrable.has(read.operation.result.id)) continue
        const readSites = uses.get(read.operation.result.id)
        const readSite = readSites?.length === 1 ? readSites[0] : undefined
        if (!readSite || readSite.block !== blockId) continue
        const consumer =
          readSite.index < block.operations.length
            ? block.operations[readSite.index]
            : readSite.index === block.operations.length + 1
              ? block.terminator
              : undefined
        if (consumer === undefined) continue
        if (!forwardedReadPositionAllowed(consumer, read.operation.result.id, read.operation.result.representation, pureGet)) continue
        // Effect-free is the condition here, not withheld: a pure read that
        // kept its temporary because ITS use lies past some later call still
        // writes nothing, and the written expression only has to reach the
        // read without anything changing what it names. From the read to its
        // use the read's own deferral has already proved the window clear.
        let clear = true
        for (let between = index + 1; between < read.index; between += 1) {
          const crossed = block.operations[between]
          if (!crossed || (crossed.kind !== 'phi' && !isDeferrableOperation(crossed, pureGet))) clear = false
        }
        if (!clear) continue
        if (!forwarding.forwardsBinding(operation, read.operation)) continue
        bindingCandidates.push({
          declaration: operation.declaration,
          value: operation.value,
          read: read.operation.result.id,
          write: index,
          readAt: read.index,
          use: readSite.index
        })
        continue
      }
      if (!isDeferrableOperation(operation, pureGet)) continue
      const result = resultOfIrOperation(operation)
      if (result === null) continue
      const sites = uses.get(result.id)
      const site = sites?.length === 1 ? sites[0] : undefined
      if (!site || site.block !== blockId || site.index <= index) continue
      const limit = Math.min(site.index, block.operations.length)
      let clear = true
      for (let between = index + 1; between < limit; between += 1) if (!withheld.has(between)) clear = false
      if (!clear) continue
      withheld.add(index)
      deferrable.add(result.id)
      const reader = block.operations[site.index]
      if (reader && (reader.kind === 'call' || reader.kind === 'construct' || reader.kind === 'super-initialize')) {
        if (!reader.arguments.some((argument) => argument.value === result.id)) continue
        consumedByCall.add(result.id)
      }
    }
  }
  for (const candidate of bindingCandidates) {
    if (!deferrable.has(candidate.value.value)) continue
    const producer = producers.get(candidate.value.value)
    // A formal reaches its reads by name already (`emit-bindings.ts`'s
    // `collectFormalCells`), and that decision stays where it is.
    if (producer === undefined || producer.kind === 'parameter' || producer.kind === 'receiver') continue
    // A forwarded CALL moves to the read's use, so it may cross nothing at all
    // -- not even a withheld read, whose place inside the use's expression C++
    // orders however it likes.
    if (
      forwardableProducerKinds.has(producer.kind) &&
      !(candidate.readAt === candidate.write + 1 && candidate.use === candidate.readAt + 1)
    )
      continue
    forwardedBindings.set(candidate.declaration, { value: candidate.value, read: candidate.read })
  }
  return { values: deferrable, consumedByCall, forwardedBindings }
}
