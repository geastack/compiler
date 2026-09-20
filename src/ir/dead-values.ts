import type { IrValueId } from '../identity/ids.js'
import type { ConstructOperation, GetOperation, IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'
import { arrayAllocationDrainsDynamicIterator, operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Which results nothing reads, and whose operations may therefore render
 * nothing at all.
 *
 * The IR is three-address form and every producer publishes a result, whether
 * or not the program goes on to read it. A component's render body reads a
 * field the plugin then re-reads through a reactive thunk; a key literal is
 * spelled inline by the member access it keys; a callee that is only ever
 * called by name never needs the function object built for it. Each of those
 * left a statement behind -- `v20 = gea_this->cities;` with no reader,
 * `v13 = "length";`, `v7 = gea::CallableObject<...>{&body, nullptr};` --
 * which the C++ compiler may or may not remove (a `Ref` copy is an atomic
 * increment it may not) and which a reader of the output has to prove dead
 * by hand. `examples/apps/weather` carried 142 unread literal temporaries and
 * 18 unread field reads in one unit.
 *
 * Deletion is a fixed point: an operation whose only reader was itself dead
 * becomes dead in turn, so a chain of pure operations feeding one unread
 * value disappears whole.
 *
 * Only an operation that neither writes nor runs program code may go. The
 * whitelist is by kind, with three exceptions decided per operation:
 *
 * - a `get` is a pure load off an Array, a string, or a record field with no
 *   accessor, and a call into the program through an accessor -- the emitter
 *   answers which, since it alone knows the receiver's layout;
 * - `compute` and `convert` are arithmetic on primitives and `ToPrimitive`
 *   (which runs `valueOf`) on anything else, so they qualify only over
 *   primitive operands;
 * - `test` is a comparison, pure on every carrier but the boxed one, where it
 *   may reach `valueOf` through loose equality.
 *
 * A `call` reads its callee -- unless the emitter reaches the body by name,
 * in which case the callee's carrier is never spelled. `directCallee` says
 * which producers those are (see `targets/cpp/emit-context.ts`'s
 * `directCallees`), so a function object that exists only to be called
 * directly counts as unread. The name itself is registered up front for
 * every callee `ir/call-dispatch.ts`'s `CallOperation.target` resolved
 * (`emit.ts`'s `emitBody`), independent of whether this producer ends up
 * dead -- what `emit.ts` still has to do where it skips the dead operation is
 * only the handful of side effects genuinely tied to the skipped RENDER
 * itself (a reactive thunk's stashed value, a method read's stashed
 * receiver), never the direct-callee name.
 */
export interface DeadValueRules {
  /** Whether this member read is a plain load rather than a call into the program. `key` is the IR's own text for a string-literal key, or `null`. */
  readonly pureGet: (operation: GetOperation, key: string | null) => boolean
  /** Whether a call through this producer's result reaches the body by name, never spelling the carrier. */
  readonly directCallee: (producer: IrNonTerminatorOperation) => boolean
  /** Whether a construction through this producer reaches the class constructor by name, never spelling the carrier. */
  readonly directConstructor: (producer: IrNonTerminatorOperation) => boolean
  /**
   * Whether constructing this operation's result has no consequence anything
   * else can observe -- `ir/instantiation.ts`'s
   * `classesConstructedUnobservably`, asked of the class the result carries.
   */
  readonly pureConstruct: (operation: ConstructOperation) => boolean
  /**
   * Whether the body this call reaches never names its receiver, so the
   * receiver operand is not a read of it.
   *
   * A stateless gea component is the case: its render ignores `this`, but the
   * call still has to hand it one, so a `construct` runs to manufacture a
   * receiver nothing looks at. Combined with `pureConstruct`, that whole
   * construction goes. The emitter then spells a default-constructed receiver
   * at the call, because the callee's SIGNATURE still declares the formal --
   * this drops the argument's value, not the parameter.
   */
  readonly ignoresReceiver: (callee: IrNonTerminatorOperation | undefined) => boolean
}

const alwaysPureKinds: ReadonlySet<IrNonTerminatorOperation['kind']> = new Set([
  'constant',
  'binding-read',
  'parameter',
  'receiver',
  'has-property',
  'allocate-callable',
  'allocate-constructor',
  'phi'
])

const primitiveKinds: ReadonlySet<string> = new Set(['scalar', 'string', 'null', 'undefined', 'symbol'])

const isPrimitive = (operand: IrOperand): boolean => primitiveKinds.has(operand.representation.kind)

const isEffectFree = (
  operation: IrNonTerminatorOperation,
  rules: DeadValueRules,
  keyTextOf: (operand: IrOperand) => string | null
): boolean => {
  if (alwaysPureKinds.has(operation.kind)) return true
  // A `gather` element drains a genuinely dynamic iterator, which can invoke
  // a user-defined method -- see `queries.ts`'s
  // `arrayAllocationDrainsDynamicIterator`. An ordinary literal or a native
  // `spread` range-copy stays pure; only that one arm is not "read nothing,
  // run nothing" the way this operation is for every other array shape.
  if (operation.kind === 'allocate-array-object') return !arrayAllocationDrainsDynamicIterator(operation)
  if (operation.kind === 'get') return rules.pureGet(operation, keyTextOf(operation.key))
  if (
    operation.kind === 'compute' &&
    (operation.form === 'require-object-coercible' ||
      operation.form === 'require-iterable-present' ||
      operation.form === 'require-tagged-union-arm')
  )
    return false
  if (operation.kind === 'compute' || operation.kind === 'convert') return operandsOfIrOperation(operation).every(isPrimitive)
  if (operation.kind === 'test') return operandsOfIrOperation(operation).every((operand) => operand.representation.kind !== 'dynamic')
  if (operation.kind === 'construct') return rules.pureConstruct(operation)
  return false
}

/** Every string-literal constant's text by value, for member-read purity: a `get` keyed by `"width"` is asked about the member `width`. */
export const stringConstantsOf = (body: IrBody): ReadonlyMap<IrValueId, string> => {
  const texts = new Map<IrValueId, string>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'constant' && operation.literal === 'string') texts.set(operation.result.id, operation.text)
    }
  }
  return texts
}

/** Every boolean-literal constant by value, so a branch on one renders as the jump it is. */
export const booleanConstantsOf = (body: IrBody): ReadonlyMap<IrValueId, boolean> => {
  const known = new Map<IrValueId, boolean>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'constant' && operation.literal === 'boolean') known.set(operation.result.id, operation.text === 'true')
    }
  }
  return known
}

/**
 * Results no later operation or terminator reads, including effectful
 * producers whose operation must remain.
 *
 * `deadValuesOf` is deliberately narrower: it identifies whole operations
 * the emitter may delete. A call with an unread result is different. The call
 * still runs, but assigning its return value into a temporary pays carrier
 * work that the source program never observes (a returned `Ref`, for example,
 * performs reference-count traffic). Keeping this census separate prevents
 * an effectful operation from ever being mistaken for a deletable one while
 * still letting its backend discard the C++ return value directly.
 */
export const unreadValuesOf = (body: IrBody): ReadonlySet<IrValueId> => {
  const produced = new Set<IrValueId>()
  const read = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result !== null) produced.add(result.id)
      for (const operand of operandsOfIrOperation(operation)) read.add(operand.value)
    }
    for (const operand of operandsOfIrOperation(block.terminator)) read.add(operand.value)
  }
  for (const region of body.iteratorCloseRegions ?? []) read.add(region.iterator.value)
  return new Set([...produced].filter((value) => !read.has(value)))
}

export const deadValuesOf = (body: IrBody, rules: DeadValueRules): ReadonlySet<IrValueId> => {
  const producers = new Map<IrValueId, IrNonTerminatorOperation>()
  const readers = new Map<IrValueId, number>()
  const count = (value: IrValueId, by: number): void => {
    readers.set(value, (readers.get(value) ?? 0) + by)
  }
  // A call/construct's callee is read by the operation -- except when the body
  // is reached by name, in which case the carrier is never spelled and its
  // producer is as unread as if the invocation were not there. Guarded on the
  // operand being non-optional: `f?.()` unwraps an `Optional` first, and the
  // call site spells THAT value, not the one the producer published.
  const readsOf = (operation: IrNonTerminatorOperation): readonly IrOperand[] => {
    const operands = operandsOfIrOperation(operation)
    if (operation.kind === 'construct') {
      const producer = producers.get(operation.callee.value)
      if (operation.callee.representation.kind !== 'optional' && producer !== undefined && rules.directConstructor(producer)) {
        // An ordinary `new C()` publishes C as both [[Construct]]'s callee and
        // its newTarget. The named constructor path spells neither carrier;
        // filtering by value drops both roles when they are that same value,
        // while a distinct Reflect.construct newTarget remains a real read.
        return operands.filter((operand) => operand.value !== operation.callee.value)
      }
      return operands
    }
    if (operation.kind !== 'call') return operands
    const producer = producers.get(operation.callee.value)
    const ignored = new Set<IrOperand>()
    // The callee is read unless the body is reached by name. Guarded on the
    // operand being the callee itself: `f?.()` unwraps an `Optional` first, and
    // the call site spells THAT value, not the one the producer published.
    // A producer may name a body directly while a later conversion exposes it
    // as a boxed dynamic callable. That call necessarily reads the box through
    // `callAsFunction`; deleting the producer under the direct-body rule leaves
    // the emitter with a real callee use and no definition. The callable's
    // carrier at THIS call site decides whether the value is spelled.
    if (
      operation.callee.representation.kind !== 'optional' &&
      operation.callee.representation.kind !== 'dynamic' &&
      producer !== undefined &&
      rules.directCallee(producer)
    )
      ignored.add(operation.callee)
    if (operation.receiver !== null && rules.ignoresReceiver(producer)) ignored.add(operation.receiver)
    if (ignored.size === 0) return operands
    return operands.filter((operand) => !ignored.has(operand))
  }
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result !== null) producers.set(result.id, operation)
    }
  }
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) for (const operand of readsOf(operation)) count(operand.value, 1)
    for (const operand of operandsOfIrOperation(block.terminator)) count(operand.value, 1)
  }
  for (const region of body.iteratorCloseRegions ?? []) count(region.iterator.value, 1)
  const strings = stringConstantsOf(body)
  const keyTextOf = (operand: IrOperand): string | null => strings.get(operand.value) ?? null
  const pure = (value: IrValueId): boolean => {
    const producer = producers.get(value)
    return producer !== undefined && isEffectFree(producer, rules, keyTextOf)
  }
  const dead = new Set<IrValueId>()
  const pending = [...producers.keys()].filter((value) => (readers.get(value) ?? 0) === 0 && pure(value))
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === undefined || dead.has(value)) continue
    dead.add(value)
    const producer = producers.get(value)
    if (producer === undefined) continue
    for (const operand of readsOf(producer)) {
      // A direct class-method read is deleted as a materialized callable, but
      // its receiver is retained beside the result for the later direct call.
      // The call therefore still reads this operand even though it does not
      // read the method carrier. Decrementing it here can delete the receiver
      // and leave the direct call naming an SSA value with no definition.
      if (producer.kind === 'get' && rules.directCallee(producer) && operand === producer.receiver) continue
      count(operand.value, -1)
      if (readers.get(operand.value) === 0 && pure(operand.value)) pending.push(operand.value)
    }
  }
  return dead
}
