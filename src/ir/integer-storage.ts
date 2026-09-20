import type { DeclarationId, FunctionId, IrValueId, RegionId } from '../identity/ids.js'
import { walkRepresentation, type Representation } from '../representation/model.js'
import {
  integerLinearMagnitude,
  narrowableIntegersOf,
  widenIntegerMagnitude,
  type IntegerMagnitude,
  type IntegerNarrowing,
  type IntegerStorageFacts
} from './integers.js'
import type { IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Which record and class FIELDS this program may hold in a 64-bit integer.
 *
 * `ir/integers.ts` answers the same question for one body's own values and
 * cells, and stops at storage: a field is one slot shared by every body that
 * touches it, so no single body can settle what it holds. That limit is not
 * academic. `bench/comparison/fixtures/object_create.ts` carries its whole
 * result through `Point.x/y/z`, and the hand-written baseline beside it
 * declares `struct Point { long long x, y, z; }`; while those three members are
 * doubles the loop's `(total + o.x + o.y + o.z) % 1000000000` is four
 * floating-point operations and an `fmod` where the baseline has four integer
 * ones and a compare-subtract.
 *
 * So this census runs over EVERY body at once and answers per slot, in the two
 * passes the lattice in `integers.ts` requires and in that order:
 *
 *   1. Integrality, optimistically. Assume every candidate slot holds an
 *      integer, then strike any slot some write proves otherwise. A field
 *      written from itself (`this.value = (this.value + n) % C`) is a cycle,
 *      and the greatest fixed point is the honest reading of it.
 *   2. Magnitude, pessimistically. Start with no slot bounded and let each
 *      round derive what the previous one justifies. `%` by a constant bounds
 *      its result whatever the dividend was, which is what lets a cycle settle
 *      at all; a slot that never settles keeps no bound and narrows nowhere.
 *
 * Both passes drive `narrowableIntegersOf` itself rather than restating its
 * lattice, so a field and a local can never disagree about what an integer is.
 */
export interface IntegerStorageCensus {
  /** The slots whose C++ storage may be `long long`. */
  readonly slots: ReadonlySet<string>
  /** What one body should be censused with, so its reads of those slots narrow too. */
  readonly factsOf: (owner: FunctionId | RegionId) => IntegerStorageFacts
}

/**
 * A field's identity across the whole program: the struct that declares the
 * member, and the source key.
 *
 * Keyed by struct NAME rather than by shape id because the struct name is what
 * the C++ declaration is spelled from -- a class is `cppClassName`, a record is
 * `cppRecordStructName`, and only the caller knows which. A slot that could not
 * be matched to the member being rendered would narrow every read of it and
 * leave the storage a double.
 */
export const integerStorageSlot = (structName: string, key: string): string => `${structName} ${key}`

/**
 * One FORMAL's identity across the whole program: the body it belongs to, and
 * its position.
 *
 * A parameter is storage in exactly the sense a field is: one slot, written by
 * every call site and read by the body. `bench/comparison/fixtures/fibonacci.ts`
 * is the whole argument -- its `n` is only ever `40`, `n - 1` and `n - 2`, and
 * the hand-written baseline beside it declares `static long long fib(int n)`.
 * A census that stopped at fields would leave that body doing its compare, its
 * two subtractions and its recursion in doubles.
 *
 * Spelled with a `#` where a field's slot has a space, so the two families of
 * slot share one map without a key of either ever reading as the other.
 */
export const integerParameterSlot = (owner: FunctionId | RegionId, ordinal: number): string => `${String(owner)}#${ordinal}`

/**
 * A body's RESULT, as one slot the same way its formals are.
 *
 * The half without which narrowing a formal can cost more than it saves: with
 * `tick(n)` computing in a `long long` and still DECLARED to return a double,
 * every call converts on the way out and its caller adds the result to a double
 * -- measured on `bench/comparison/fixtures/method_calls.ts`, that one
 * conversion put the fixture 33% behind where it had been before either half
 * landed. Written by every `return` in the body and read at every call site
 * whose callee this census resolved.
 */
export const integerResultSlot = (owner: FunctionId | RegionId): string => `${String(owner)}#result`

/** The struct half of a slot, for the disqualifications that are struct-wide. Empty for a formal's slot, which no struct owns. */
const structOfSlot = (slot: string): string => {
  const boundary = slot.indexOf(' ')
  return boundary < 0 ? '' : slot.slice(0, boundary)
}

export interface IntegerStorageQuestion {
  readonly bodies: readonly IrBody[]
  /** The struct a carrier IS, or `null` when this census may not name one (a host struct, a non-record). */
  readonly structNameOf: (representation: Representation) => string | null
  /** Every native struct whose storage a value exposes, including class bases. */
  readonly structFamilyOf: (representation: Representation) => readonly string[]
  /** A field uses its physical declaring struct, not its receiver's static subclass. */
  readonly fieldStructNameOf: (representation: Representation, key: string) => string | null
  /** The physical field carrier, independent of the value written into it. */
  readonly fieldRepresentationOf: (representation: Representation, key: string) => Representation | null
  /**
   * Struct names this census may not touch at all.
   *
   * A field's storage is read and written by emitted code this census cannot
   * see: `gea_json_read(reader, out.x)` binds a `double&`, a reactive member is
   * a `Signal<double>`, a host struct is the host's own declaration. Each of
   * those is a separate authority over the same member, and the only safe
   * answer is to leave the whole struct alone.
   */
  readonly excludedStructs: ReadonlySet<string>
  /**
   * Class field default initializers: the slot, and the body whose RETURN value
   * seeds it.
   *
   * `class Counter { value: number = 0 }` writes that member from
   * `class-layout.ts`'s generated initializer call, not from any `set` in any
   * body -- so a census that only walked operations would narrow a member whose
   * one seed it never examined.
   */
  readonly fieldSeeds: ReadonlyMap<string, readonly { readonly initializer: FunctionId; readonly representation: Representation | null }[]>
  /**
   * Which single body each callable cell holds -- `buildDirectCallableIndex`.
   *
   * A module function's cell carries `function-value-dispatch`, which names no
   * body at all; the emitter still calls it directly because this index says
   * the cell is written exactly once with a non-capturing callable. The census
   * needs the same answer for the same reason, and taking it from the same
   * place is what keeps "the call the emitter renders" and "the call this
   * census attributed an argument to" one call.
   */
  readonly directCallees: ReadonlyMap<DeclarationId, FunctionId>
  /**
   * The body a `class key` member call reaches, keyed `"<declaration> <key>"`.
   *
   * A method's callee carries the same dispatching carrier every callable does,
   * and the site that reads `c.tick` allocates one -- so neither the carrier nor
   * `directCallees` says which body runs. The emitter answers it from the class
   * layout, and so does this, from a map the caller builds off the SAME layout
   * and leaves empty for any key a virtual family overrides.
   */
  readonly methodBodies: ReadonlyMap<string, FunctionId>
  /**
   * Bodies whose formals may not be narrowed however complete their slots are.
   *
   * A body reached through a declaration this compilation generates rather than
   * renders -- a virtual dispatch member, a constructor's own definition --
   * has a SECOND spelling of its formals, written from the ABI by a different
   * file. Narrowing the body alone would make the two disagree; narrowing both
   * would put one member in front of implementations that did not all narrow.
   */
  readonly excludedFormalOwners: ReadonlySet<string>
  /**
   * Individual SIGNATURE slots -- a formal or the result -- whose declared
   * carrier is not a `number` at all.
   *
   * A formal slot is written by its call sites, and a call site's argument
   * carries the value's own representation -- a `double` -- even where the
   * parameter it fills is a union the argument is widened into on the way in.
   * Reading only the writes, this census concluded that `f(x: number | string)`
   * called `f(3)` holds an integer in slot 0, and the body's formal was spelled
   * `long long` while every caller, the thunk and the `CallableObject` carrier
   * kept the `TaggedUnion` the ABI declares. That is not a narrowing: the two
   * spellings are different types, and the cast between them does not exist.
   *
   * A result slot is the same question asked at the other end of the frame, and
   * an `async` body is the case that proves it has to be asked there too: its
   * terminator really does carry a `number`, and its convention really does
   * return `gea::Promise<double>`, because the emitter wraps the returned value
   * on the way out. Reading only the terminator, this census narrowed the slot
   * and the signature was spelled `long long` around a body whose one `return`
   * statement is `return gea::Promise<double>(v0);` -- a program that certified
   * clean and that clang refuses.
   *
   * The ABI is the authority on what a slot holds, so it states the exclusion
   * here rather than this census inferring it from a body that may not even
   * read the formal.
   */
  readonly excludedSignatureSlots: ReadonlySet<string>
}

/** A write into one slot: the body that performs it, and the value it stores. */
interface StorageWrite {
  readonly owner: string
  readonly value: IrValueId
}

/**
 * The operations that may mention a struct-typed value without becoming a
 * second authority over what its members physically are.
 *
 * Everything here either moves the whole value (a cell, a phi, an argument, an
 * array element), tests it, or is one of the three this census models directly
 * (`get`/`set`/`define-own-property` with a constant key, and
 * `allocate-record`). Every other spelling -- `Object.values` building a
 * `std::vector<double>` out of the members, `own-property-keys`, a spread, an
 * `await` -- reads or writes a member through a type it decided for itself, and
 * a member this census narrowed would silently disagree with it. So the struct
 * is struck instead: the accounting has to be COMPLETE before a slot's writes
 * are a proof rather than a sample.
 */
const accountedOperations: ReadonlySet<string> = new Set([
  'get',
  'set',
  'define-own-property',
  'allocate-record',
  'allocate-array-object',
  'binding-read',
  'binding-write',
  'phi',
  'parameter',
  'receiver',
  'constant',
  'compute',
  'test',
  'call',
  'construct',
  'super-initialize'
])

/**
 * Operations that move a whole value and never spell one of its members.
 *
 * A JSX slot and a capture list both take the value and put it somewhere this
 * census does not read -- a host element's property, a capture struct -- which
 * is why neither is in `accountedOperations`. For a CLASS carrier that is not a
 * second authority over anything: the carrier is a pointer (`Ref<T>`), the
 * thing at the other end is the one struct this compilation renders, and
 * whatever slot it is moved into is spelled from the same representation. So a
 * class mentioned in one of these positions is accounted for, and it is the
 * difference between narrowing `examples/apps/weather`'s store and striking it
 * -- eleven integer flags, every one of them handed to a `<View>` prop and
 * captured by an effect, and therefore `Signal<double>` on a core with no
 * double FPU.
 *
 * A RECORD in the same position is a different question and stays struck: a
 * host reads a `style={{...}}` record's members through the type IT declares,
 * which is exactly the second authority `excludedStructs` exists for.
 */
const wholeValueMoves: ReadonlySet<string> = new Set(['element-prop', 'element-child', 'allocate-callable', 'allocate-constructor'])

/**
 * The Array, Map and Set methods that move their element arguments WHOLE and
 * never spell one of the element's members.
 *
 * A call the census cannot attribute to a body strikes the struct of every
 * operand, because an unknown callee could read or write a member through a
 * type it chose itself. A container method is not unknown: `push` copies the
 * record into a cell, `get` copies it back out, `forEach` hands it whole to a
 * program callback (whose own body the census reads, and whose escape the
 * operand walk records). Without this list `ring.push({x, y, z})` alone kept
 * `object_create`'s three members doubles.
 *
 * Deliberately NOT here: anything that reads members through a conversion of
 * its own -- `join`, `toString`, `toLocaleString`, and `sort` without a
 * comparator (which compares by ToString) -- and every method of a
 * non-container host (`Object.values`, `JSON.stringify`, `console.log`
 * reach their argument's members through the dynamic protocol, which is the
 * box accounting's business, not this list's).
 */
const wholeElementMethods: ReadonlySet<string> = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'fill',
  'reverse',
  'at',
  'indexOf',
  'lastIndexOf',
  'includes',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'forEach',
  'map',
  'filter',
  'reduce',
  'reduceRight',
  'flat',
  'flatMap',
  'copyWithin',
  'entries',
  'keys',
  'values',
  'with',
  'toReversed',
  'toSpliced',
  'sort',
  'get',
  'set',
  'has',
  'add',
  'delete',
  'clear'
])

/**
 * Every carrier that holds something invocable.
 *
 * A formal's slot is only as complete as the set of calls that write it, so a
 * callable this census cannot follow is a call site it cannot see. These are
 * the carriers that hold one; where each is allowed to APPEAR is decided in
 * `scanBody`.
 */
const callableCarriers: ReadonlySet<string> = new Set([
  'function',
  'function-family',
  'function-value-family',
  'function-value-dispatch',
  'function-and-constructor',
  'constructor-family',
  'constructor-value-dispatch'
])

/**
 * The bodies a callee carrier NAMES, or `null` when the carrier alone does not
 * say.
 *
 * Most direct calls do not have a naming carrier: a module function is a cell
 * whose carrier is `function-value-dispatch`, and it is `buildDirectCallableIndex`
 * -- the same authority the emitter calls the body by name from -- that says
 * which one body that cell holds. So this answers what the representation
 * states, and `scanBody` asks the index for the rest.
 */
const calleeOwnersOf = (representation: Representation): readonly string[] | null => {
  if (representation.kind === 'function') return [String(representation.functionId)]
  if (representation.kind === 'function-family') return representation.members.map(String)
  return null
}

interface BodyScan {
  readonly owner: string
  /**
   * The structs a box in this body puts at risk.
   *
   * A boxed value carries its payload's C++ type with it, and `gea::Value`'s
   * `Tag::Number` is read back as a `double` by every reader (see
   * `canonicalDynamicPayloads` in `targets/cpp/records.ts`). A narrowed member
   * boxed under that tag would be punned, so the struct dispatcher refuses it --
   * loudly, at runtime, which is a program that used to work and now aborts.
   *
   * What decides the risk is WHAT each box carries, not that the body boxes at
   * all. `examples/apps/weather` is the whole argument: its one box in 10,943
   * lines of C++ is `throw new Error('gea-embedded mount root #app was not
   * found')` -- `Tag::Object` around an Error record, which cannot pun a
   * numeric member of anything. Reading that as "this program boxes" switched
   * off every field, formal and result the census could otherwise narrow,
   * including eleven `Signal<double>` flags on a core with no double FPU.
   *
   * So a box strikes the struct its payload NAMES, and only that struct.
   */
  readonly boxedStructs: ReadonlySet<string>
  /**
   * Candidate slots whose own read is boxed.
   *
   * A narrowed slot read produces a `long long`, and boxing it under
   * `Tag::Number` stores a `double`: exact only below 2^53, where the census's
   * own bound is 2^62 (`kIntegerBoundLimit`). The slot is struck rather than
   * the bound tightened, because a slot read into a box is one this
   * compilation has no reason to hold in an integer anyway.
   */
  readonly boxedSlots: ReadonlySet<string>
  /**
   * A box this census cannot see the payload of.
   *
   * The fail-closed half, and the reason the per-struct rule is sound. A member
   * read off a boxed receiver is itself a box -- `v.b` where `v` is boxed
   * produces another boxed value -- and the payload of THAT one is not named by
   * anything: its defining operation is the read, not a conversion out of a
   * struct. One such box and the census refuses the whole program exactly as it
   * used to, so the transitive case cannot be narrowed by accident. What it
   * costs is a program that reads a member through a box; what it buys is every
   * program that merely throws.
   */
  readonly boxOpaque: boolean
  /** Every `get` or `parameter` result this body takes out of a candidate slot. */
  readonly reads: Map<IrValueId, string>
  /**
   * Reads of a cell that holds nothing but one slot's value.
   *
   * A formal is almost never used directly: the frontend writes it into the
   * declaration's own cell and every mention of the name is a read of that
   * cell. `fib`'s `n - 1` therefore subtracts from a cell, not from the
   * `parameter` result, and `selfStepOf` would not recognize its own slot
   * without this. Kept apart from `reads` because it is an inference about a
   * cell, not the operation the census actually saw.
   */
  readonly slotCells: Map<IrValueId, string>
  /** Every value this body puts into one, by slot. */
  readonly writes: Map<string, IrValueId[]>
  /** The value a `return` in this body carries, when it carries exactly one. */
  readonly returns: IrValueId | null
  /** Whether every `return` in this body carries a plain `number` -- what makes its result one slot. */
  readonly returnsNumber: boolean
  /**
   * The binary arithmetic this body performs, and the integer constants it
   * names -- what pass 2 needs to recognize a write that reads its OWN slot and
   * steps it by a constant. See `selfStepOf`.
   */
  readonly steps: Map<IrValueId, { readonly operator: string; readonly left: IrValueId; readonly right: IrValueId }>
  readonly constants: Map<IrValueId, number>
  /**
   * The bodies whose callable this one puts somewhere it could be invoked from
   * unseen -- an array element, a record member, a host argument, a return.
   *
   * A per-function answer rather than one flag, and the difference is the whole
   * of what makes a formal narrowable in a program that uses closures at all.
   * A call this census cannot attribute reaches SOME body, but not any body:
   * an indirect call can only land on a function whose callable became a value
   * in the first place, and the first hop out of the `allocate-callable` that
   * made it is always attributable. So flagging that hop names every function
   * an unattributed call could reach, and a function whose callable only ever
   * sits in its own cell -- the module binding every top-level declaration gets
   * -- is not one of them.
   *
   * A callable operand this census cannot name adds nothing: it is opaque
   * because it came out of a call, a member or a formal, and whatever put it
   * there was itself an operand position this walk saw.
   *
   * Fields are untouched either way, since a call can write one only through a
   * body this census reads.
   */
  readonly escapedCallables: ReadonlySet<string>
}

const isNumberScalar = (representation: Representation): boolean => representation.kind === 'scalar' && representation.domain === 'number'

const sameMagnitude = (left: IntegerMagnitude | undefined, right: IntegerMagnitude): boolean => {
  if (left === undefined || left.kind !== right.kind) return false
  if (left.kind === 'bounded' && right.kind === 'bounded') return left.limit === right.limit
  return left.kind === 'linear' && right.kind === 'linear' && left.coefficient === right.coefficient
}

/**
 * How far one write steps the slot it reads, when that is all it does.
 *
 * `fib`'s formal is written by `40`, by `n - 1` and by `n - 2`, and the last
 * two READ the slot they write. Derived the ordinary way those two are circular
 * -- the slot's bound is the previous round's bound plus one, which climbs a
 * round at a time and never settles -- and the census would refuse a formal
 * whose whole range is `[0, 40]`. Recognized as a step, they are exactly what
 * `integerLinearMagnitude` already models for a loop counter, and the same
 * argument bounds them.
 */
const selfStepOf = (scan: BodyScan, slot: string, value: IrValueId): number | null => {
  const step = scan.steps.get(value)
  if (step === undefined || (step.operator !== '+' && step.operator !== '-')) return null
  if (scan.reads.get(step.left) !== slot && scan.slotCells.get(step.left) !== slot) return null
  const constant = scan.constants.get(step.right)
  return constant === undefined ? null : Math.abs(constant)
}

/**
 * Whether one write of a body's OWN result is the sum of two of its own calls.
 *
 * `fib` returns `fib(n - 1) + fib(n - 2)`, and derived the ordinary way that is
 * the same circularity `selfStepOf` was written for, only doubling instead of
 * climbing: the slot's bound is twice the previous round's, so eight rounds
 * multiply it by 256 and it never settles. The census then refuses a result
 * whose whole range is `[0, 2^40]` and `fib` keeps a double.
 *
 * Recognized as a recursion, the bound is the same argument the file already
 * makes for a loop counter. Such a body returns a sum of BASE-case values, one
 * per leaf call, so a result of `M` needs at least `M / B` calls with `B` the
 * base's own bound -- the value grows by at most `B` per call, exactly what
 * `integerLinearMagnitude(B)` means, and the coefficient cap is what refuses a
 * base big enough to reach 2^53 in few enough calls to matter.
 *
 * Only `+`, and deliberately: `f(n - 1) * f(n - 2)` reaches 2^53 in ~53 nested
 * frames, and no argument about call counts bounds it.
 */
const selfSumOf = (scan: BodyScan, slot: string, value: IrValueId): boolean => {
  if (`${scan.owner}#result` !== slot) return false
  const sum = scan.steps.get(value)
  if (sum === undefined || sum.operator !== '+') return false
  return scan.reads.get(sum.left) === slot && scan.reads.get(sum.right) === slot
}

const emptyFacts: IntegerStorageFacts = { reads: new Map(), integral: new Set(), magnitudes: new Map() }

export const emptyIntegerStorageCensus: IntegerStorageCensus = { slots: new Set(), factsOf: () => emptyFacts }

/** How many times each pass may re-derive before it gives up and refuses every slot. */
const settlingRounds = 8

const scanBody = (body: IrBody, question: IntegerStorageQuestion, disqualified: Set<string>): BodyScan => {
  const owner = String(body.sourceOwner)
  const constantTexts = new Map<IrValueId, string>()
  const reads = new Map<IrValueId, string>()
  const writes = new Map<string, IrValueId[]>()
  const steps = new Map<IrValueId, { readonly operator: string; readonly left: IrValueId; readonly right: IrValueId }>()
  const constants = new Map<IrValueId, number>()
  const cellReads = new Map<IrValueId, DeclarationId>()
  const allocatedCallables = new Map<IrValueId, string>()
  const methodReads = new Map<IrValueId, string>()
  const cellWrites = new Map<DeclarationId, IrValueId[]>()
  const slotCells = new Map<IrValueId, string>()
  let returns: IrValueId | null = null
  let returnCount = 0
  let returnsNumber = true
  const boxedStructs = new Set<string>()
  const boxedSlots = new Set<string>()
  const boxedValues = new Set<IrValueId>()
  let boxOpaque = false
  const escapedCallables = new Set<string>()

  // Two walks: a key is a `constant` operation and nothing orders it before the
  // access that names it, so the texts have to be complete before any access is
  // read.
  //
  // The same pre-pass records what each value was DEFINED as, and the source of
  // every conversion, because a box is asked what it carries and the answer is
  // never at the box itself: a value's carrier at the use site is already the
  // `dynamic` one, and its payload is whatever it was before the conversion.
  const definedRepresentations = new Map<IrValueId, Representation>()
  const convertSources = new Map<IrValueId, IrValueId>()
  for (const blockId of body.blockOrder) {
    for (const operation of body.blocks.get(blockId)?.operations ?? []) {
      const produced = resultOfIrOperation(operation)
      if (produced !== null) definedRepresentations.set(produced.id, produced.representation)
      if (operation.kind === 'convert') convertSources.set(operation.result.id, operation.source.value)
      if (operation.kind === 'binding-read') cellReads.set(operation.result.id, operation.declaration)
      if (operation.kind === 'allocate-callable') allocatedCallables.set(operation.result.id, String(operation.functionId))
      if (operation.kind !== 'constant') continue
      constantTexts.set(operation.result.id, operation.text)
      if (operation.literal !== 'number') continue
      const numeric = Number(operation.text)
      if (Number.isFinite(numeric) && Number.isInteger(numeric)) constants.set(operation.result.id, numeric)
    }
  }

  /**
   * What a boxed value carries, or `null` when this census cannot say.
   *
   * A conversion into the dynamic carrier is followed to its source, because
   * that source's carrier IS the payload -- `throw new Error(...)` boxes a
   * record, and the record is one operand back. A value whose definition is
   * already dynamic and is not a conversion (a member read off a boxed
   * receiver) has no payload anything names, and `null` is the honest answer:
   * `boxOpaque` turns it into a refusal rather than a guess.
   */
  const boxPayloadOf = (value: IrValueId): Representation | null => {
    const seen = new Set<IrValueId>()
    let at: IrValueId | undefined = value
    while (at !== undefined && !seen.has(at)) {
      seen.add(at)
      const representation = definedRepresentations.get(at)
      if (representation === undefined) return null
      if (representation.kind !== 'dynamic') return representation
      at = convertSources.get(at)
    }
    return null
  }

  const write = (slot: string, value: IrValueId): void => {
    const existing = writes.get(slot) ?? []
    existing.push(value)
    writes.set(slot, existing)
  }

  // A second pre-pass: a member read needs its key's text, which the first one
  // is what completes. The same pass names the CONTAINER methods read off an
  // Array, Map or Set -- see `wholeElementMethods`.
  const containerMethodReads = new Map<IrValueId, string>()
  for (const blockId of body.blockOrder) {
    for (const operation of body.blocks.get(blockId)?.operations ?? []) {
      if (operation.kind !== 'get') continue
      const key = constantTexts.get(operation.key.value)
      if (key === undefined) continue
      const receiver = operation.receiver.representation
      if (receiver.kind === 'class-ref') {
        const method = question.methodBodies.get(`${receiver.declaration} ${key}`)
        if (method !== undefined) methodReads.set(operation.result.id, String(method))
        continue
      }
      const container = receiver.kind === 'optional' ? receiver.payload : receiver
      if ((container.kind === 'array-object' || container.kind === 'keyed-collection') && wholeElementMethods.has(key))
        containerMethodReads.set(operation.result.id, key)
    }
  }

  const calleeOwners = (callee: IrOperand): readonly string[] | null => {
    const named = calleeOwnersOf(callee.representation)
    if (named !== null) return named
    // A method reaches its body through the callable the site allocates, whose
    // carrier is the dispatching one every callable cell has. The operation
    // that built it names the body outright.
    const method = methodReads.get(callee.value)
    if (method !== undefined) return [method]
    const allocated = allocatedCallables.get(callee.value)
    if (allocated !== undefined) return [allocated]
    const cell = cellReads.get(callee.value)
    if (cell === undefined) return null
    const resolved = question.directCallees.get(cell)
    return resolved === undefined ? null : [String(resolved)]
  }

  /**
   * Record a callable leaving accountable position.
   *
   * `into` is the cell a `binding-write` puts it in, and the one exemption:
   * `question.directCallees` resolving that cell to the very function the
   * operand names is what makes a call through it attributed rather than
   * indirect, which is the ordinary shape of a top-level declaration and its
   * module binding.
   */
  const escapes = (operand: IrOperand, into: DeclarationId | null): void => {
    const owners = calleeOwners(operand)
    if (owners === null) return
    const held = into === null ? undefined : question.directCallees.get(into)
    if (held !== undefined && owners.length === 1 && owners[0] === String(held)) return
    for (const owner of owners) escapedCallables.add(owner)
  }

  const slotOf = (receiver: IrOperand, key: IrOperand): string | null => {
    const text = constantTexts.get(key.value)
    if (text === undefined) {
      // An INDEX into an Array, or any key into a dictionary, addresses an
      // element, not a member: `ring[i] = point` moves the whole record in and
      // `ring[i]` moves the whole record out, and the record's members were
      // written where it was allocated. A member is only ever reached through
      // a second `get`/`set` on the element, which this census reads on its
      // own. Reading the element access as "any member" struck every struct
      // an Array held whenever the program indexed the Array by a variable --
      // `object_create`'s whole ring, whose three members are exactly the
      // ones this census exists to narrow. A STRING key into an Array can
      // still name one of its extension fields, so it keeps the strike.
      const carrier = receiver.representation.kind === 'optional' ? receiver.representation.payload : receiver.representation
      if (carrier.kind === 'dictionary' || (carrier.kind === 'array-object' && isNumberScalar(key.representation))) return null
      // A key this compilation cannot name reaches ANY member, so no member of
      // this struct is one the census still accounts for.
      for (const held of walkRepresentation(receiver.representation))
        for (const name of question.structFamilyOf(held)) disqualified.add(name)
      return null
    }
    const structName = question.fieldStructNameOf(receiver.representation, text)
    if (structName === null) {
      // A union access may write any of its arms. Until this census models
      // that multi-slot write, none of those slots has a complete write set.
      for (const held of walkRepresentation(receiver.representation)) {
        const owner = question.fieldStructNameOf(held, text)
        if (owner !== null) disqualified.add(integerStorageSlot(owner, text))
      }
      return null
    }
    const slot = integerStorageSlot(structName, text)
    const stored = question.fieldRepresentationOf(receiver.representation, text)
    if (stored === null || !isNumberScalar(stored)) disqualified.add(slot)
    return question.excludedStructs.has(structName) ? null : slot
  }

  // Every struct this operation mentions, in any role. A struct named by an
  // operation the census does not model is one whose members some other
  // authority spells, and it is struck rather than narrowed.
  // What a `convert` does to the structs it names is read off its two
  // carriers, the same way the printer decides which recipe to render. A
  // conversion that carries the object WHOLE -- a by-value record read as a
  // view of itself, an instance upcast to its base, a record wrapped into the
  // optional or union arm that holds it, or unwrapped back out -- never spells
  // a member's type, so the C++ compiler keeps every access to the one struct
  // consistent and nothing about its slots changes. A recast into a DIFFERENT
  // struct copies member by member: the source is read through the type its
  // struct declares (a plain copy, which C++ converts), but the target's
  // members are written by values this census never sees, so that struct is
  // struck. Anything else naming a struct -- a box, a carrier this cannot
  // place -- strikes it, exactly as an unaccounted operation would.
  const carries = (holder: Representation, name: string): boolean => {
    for (const held of walkRepresentation(holder)) if (question.structNameOf(held) === name) return true
    return false
  }
  const accountConvert = (source: Representation, result: Representation): void => {
    const from = question.structNameOf(source)
    const to = question.structNameOf(result)
    if (from === null && to === null) return
    if (from !== null && to !== null) {
      if (from === to || (source.kind === 'class-ref' && result.kind === 'class-ref')) return
      disqualified.add(to)
      return
    }
    if (from !== null && !carries(result, from)) disqualified.add(from)
    if (to !== null && !carries(source, to)) disqualified.add(to)
  }

  const account = (operation: IrNonTerminatorOperation): void => {
    const result = resultOfIrOperation(operation)
    const roles = [...operandsOfIrOperation(operation), ...(result ? [{ value: result.id, representation: result.representation }] : [])]
    // What each box in this body PUTS AT RISK, rather than the fact that the
    // body boxes at all -- see `boxedStructs` and `boxOpaque`.
    for (const operand of roles) {
      if (operand.representation.kind !== 'dynamic') continue
      boxedValues.add(operand.value)
      const payload = boxPayloadOf(operand.value)
      if (payload === null) {
        boxOpaque = true
        continue
      }
      // The payload is walked rather than merely named: `Value::box(Tag::String,
      // ...)` -- which is every `console.log` -- carries no struct at all and
      // puts nothing at risk, while an Array of records carries each of them
      // without the array itself naming one.
      for (const held of walkRepresentation(payload)) {
        if (held.kind === 'dynamic' || held.kind === 'unresolved') {
          boxOpaque = true
          continue
        }
        for (const named of question.structFamilyOf(held)) boxedStructs.add(named)
      }
    }
    // A callable is accounted for only while every mention of it is a call site
    // or a move into the cell that resolves to it: those are the two positions
    // from which the census can still see -- or follow -- every invocation.
    // Anywhere else (an argument to a host function, a record member, an array
    // element) it can be invoked by something this census never reads.
    for (const operand of operandsOfIrOperation(operation)) {
      if (!callableCarriers.has(operand.representation.kind)) continue
      if ((operation.kind === 'call' || operation.kind === 'construct') && operation.callee.value === operand.value) continue
      escapes(operand, operation.kind === 'binding-write' ? operation.declaration : null)
    }
    // A call to a container method (`ring.push(point)`, `seen.add(point)`)
    // moves its arguments whole -- see `wholeElementMethods` -- so it is
    // accounted the way an element store is, and the callable operands it may
    // also carry were already walked for escapes above.
    if (operation.kind === 'call') {
      const member = containerMethodReads.get(operation.callee.value)
      if (member !== undefined && (member !== 'sort' || operation.arguments.length > 0)) return
    }
    // A `construct` needs no callee test: a struct this census can name is one
    // this compilation renders, so its constructor is a body the census reads.
    const accounted = accountedOperations.has(operation.kind) && (operation.kind !== 'call' || calleeOwners(operation.callee) !== null)
    if (accounted) return
    if (operation.kind === 'convert') {
      accountConvert(operation.source.representation, operation.result.representation)
      return
    }
    const moves = wholeValueMoves.has(operation.kind)
    for (const operand of roles) {
      // A callable signature names its inputs and result without carrying any
      // such instances. Captured values are separate operands of allocation.
      if (callableCarriers.has(operand.representation.kind)) continue
      if (moves && operand.representation.kind === 'class-ref') continue
      for (const held of walkRepresentation(operand.representation))
        for (const name of question.structFamilyOf(held)) disqualified.add(name)
    }
  }

  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      account(operation)
      if (operation.kind === 'compute' && operation.form === 'binary') {
        const [left, right] = operation.operands
        if (left && right) steps.set(operation.result.id, { operator: operation.operator, left: left.value, right: right.value })
      }
      if (operation.kind === 'parameter') {
        if (isNumberScalar(operation.result.representation))
          reads.set(operation.result.id, integerParameterSlot(body.sourceOwner, operation.ordinal))
        continue
      }
      if (operation.kind === 'call') {
        const callees = calleeOwners(operation.callee)
        if (callees === null) {
          // A call this census cannot attribute reaches one of the bodies
          // whose callable escaped, and those already keep their doubles.
          // Nothing is recorded here: the callee got its value from a position
          // the escape walk saw, so naming the reachable set again from a site
          // that says nothing about it could only be less precise.
          continue
        }
        operation.arguments.forEach((argument, ordinal) => {
          if (!isNumberScalar(argument.representation)) return
          for (const callee of callees) write(integerParameterSlot(callee as FunctionId, ordinal), argument.value)
        })
        // One callee only: two bodies reaching one call site are two result
        // slots, and this value is exactly one of them.
        const only = callees.length === 1 ? callees[0] : undefined
        if (only !== undefined && operation.result !== null && isNumberScalar(operation.result.representation)) {
          reads.set(operation.result.id, integerResultSlot(only as FunctionId))
        }
        continue
      }
      if (operation.kind === 'get') {
        const slot = slotOf(operation.receiver, operation.key)
        if (slot !== null && isNumberScalar(operation.result.representation)) reads.set(operation.result.id, slot)
        continue
      }
      if (operation.kind === 'binding-write') {
        const written = cellWrites.get(operation.declaration) ?? []
        written.push(operation.value.value)
        cellWrites.set(operation.declaration, written)
      }
      if (operation.kind === 'set' || operation.kind === 'define-own-property') {
        const slot = slotOf(operation.receiver, operation.key)
        if (slot === null) continue
        // A write of anything but a plain `number` settles the member's carrier
        // on its own, and narrowing it would make the two disagree.
        if (isNumberScalar(operation.value.representation)) write(slot, operation.value.value)
        else disqualified.add(slot)
        continue
      }
      if (operation.kind === 'delete') {
        for (const held of walkRepresentation(operation.receiver.representation))
          for (const name of question.structFamilyOf(held)) disqualified.add(name)
        continue
      }
      if (operation.kind !== 'allocate-record') continue
      const structName = question.structNameOf(operation.result.representation)
      if (structName === null || question.excludedStructs.has(structName)) continue
      for (const field of operation.fields) {
        const slot = integerStorageSlot(structName, field.key)
        const stored = question.fieldRepresentationOf(operation.result.representation, field.key)
        if (stored !== null && isNumberScalar(stored) && isNumberScalar(field.value.representation)) write(slot, field.value.value)
        else disqualified.add(slot)
      }
    }
    if (block.terminator.kind === 'return' && block.terminator.value !== null) {
      // A returned callable is the escape the operand walk cannot see: a
      // factory's arrow reaches its caller through the terminator, and every
      // later mention of it is opaque.
      if (callableCarriers.has(block.terminator.value.representation.kind)) escapes(block.terminator.value, null)
      returns = block.terminator.value.value
      returnCount += 1
      if (isNumberScalar(block.terminator.value.representation)) write(integerResultSlot(body.sourceOwner), block.terminator.value.value)
      else returnsNumber = false
    }
  }
  // A cell every write of which comes out of ONE slot is that slot, as far as
  // recognizing a step is concerned. More than one slot, or one write from
  // somewhere else, and it is not.
  const cellSlots = new Map<DeclarationId, string>()
  for (const [cell, values] of cellWrites) {
    const held = new Set(values.map((value) => reads.get(value)))
    const only = held.size === 1 ? [...held][0] : undefined
    if (only !== undefined) cellSlots.set(cell, only)
  }
  for (const [value, cell] of cellReads) {
    const slot = cellSlots.get(cell)
    if (slot !== undefined) slotCells.set(value, slot)
  }
  // After the walk, not during it: a box can precede the read whose slot it
  // names, and `reads` is only complete once every block has been seen.
  for (const value of boxedValues) {
    const slot = reads.get(value)
    if (slot !== undefined) boxedSlots.add(slot)
  }
  return {
    owner,
    reads,
    slotCells,
    writes,
    returns: returnCount === 1 ? returns : null,
    returnsNumber: returnsNumber && returnCount > 0,
    boxedStructs,
    boxedSlots,
    boxOpaque,
    steps,
    constants,
    escapedCallables
  }
}

export const integerStorageCensusOf = (question: IntegerStorageQuestion): IntegerStorageCensus => {
  const disqualified = new Set<string>()
  const scans = new Map<string, BodyScan>()
  for (const body of question.bodies) scans.set(String(body.sourceOwner), scanBody(body, question, disqualified))

  // A box whose payload this census cannot name refuses the whole program, the
  // way any box used to. Every box it CAN name strikes its own struct and the
  // slot it was read out of, and nothing else -- see `BodyScan.boxedStructs`.
  if ([...scans.values()].some((scan) => scan.boxOpaque)) return emptyIntegerStorageCensus
  const boxedSlots = new Set<string>()
  for (const scan of scans.values()) {
    for (const name of scan.boxedStructs) disqualified.add(name)
    for (const slot of scan.boxedSlots) boxedSlots.add(slot)
  }

  const bySlot = new Map<string, StorageWrite[]>()
  const record = (slot: string, write: StorageWrite): void => {
    const existing = bySlot.get(slot) ?? []
    existing.push(write)
    bySlot.set(slot, existing)
  }
  for (const scan of scans.values()) {
    for (const [slot, values] of scan.writes) for (const value of values) record(slot, { owner: scan.owner, value })
  }
  // A class field's default initializer is a body whose return value seeds the
  // member -- see `fieldSeeds`. A seed this census cannot read is a write it
  // cannot account for, so the member keeps its double.
  for (const [slot, seeds] of question.fieldSeeds)
    for (const seed of seeds) {
      const scan = scans.get(String(seed.initializer))
      if (seed.representation === null || !isNumberScalar(seed.representation) || scan === undefined || scan.returns === null)
        disqualified.add(slot)
      else record(slot, { owner: scan.owner, value: scan.returns })
    }

  const escaped = new Set<string>()
  for (const scan of scans.values()) for (const owner of scan.escapedCallables) escaped.add(owner)
  // A formal's slot and a result's slot are admitted on the same terms: both
  // are positions in a signature, and both need every call accounted for --
  // which is exactly what an escaped callable takes away, for that body alone.
  const admitsSignatureSlot = (slot: string): boolean => {
    const boundary = slot.lastIndexOf('#')
    if (boundary <= 0) return false
    const owner = slot.slice(0, boundary)
    if (escaped.has(owner)) return false
    if (question.excludedFormalOwners.has(owner) || question.excludedSignatureSlots.has(slot)) return false
    // A body that returns anything but a `number` on some path has a result
    // this census cannot narrow, whatever its numeric returns say.
    return slot.slice(boundary + 1) !== 'result' || scans.get(owner)?.returnsNumber === true
  }

  const admits = (slot: string): boolean => {
    if (disqualified.has(slot) || boxedSlots.has(slot)) return false
    if (slot.indexOf(' ') < 0) return admitsSignatureSlot(slot)
    return !disqualified.has(structOfSlot(slot)) && !question.excludedStructs.has(structOfSlot(slot))
  }

  // A slot nothing writes is one nothing can prove, so the candidates are
  // exactly the written ones -- a read-only member keeps its double.
  let integral = new Set([...bySlot.keys()].filter(admits))
  if (integral.size === 0) return emptyIntegerStorageCensus

  let magnitudes = new Map<string, IntegerMagnitude>()
  const censusRound = (): Map<string, IntegerNarrowing> => {
    const answers = new Map<string, IntegerNarrowing>()
    for (const body of question.bodies) {
      const owner = String(body.sourceOwner)
      const scan = scans.get(owner)
      if (scan === undefined || (scan.reads.size === 0 && scan.writes.size === 0 && scan.returns === null)) continue
      answers.set(owner, narrowableIntegersOf(body, { reads: scan.reads, integral, magnitudes }))
    }
    return answers
  }

  // Pass 1 -- integrality, shrinking from "every candidate holds an integer".
  for (let round = 0; round < settlingRounds; round += 1) {
    const answers = censusRound()
    const survivors = new Set<string>()
    for (const slot of integral) {
      const writes = bySlot.get(slot) ?? []
      if (writes.every((entry) => answers.get(entry.owner)?.integral.has(entry.value) === true)) survivors.add(slot)
    }
    if (survivors.size === integral.size) break
    integral = survivors
    if (integral.size === 0) return emptyIntegerStorageCensus
  }

  // Pass 2 -- magnitude, growing from "no slot is bounded". A round that
  // changes nothing is a fixed point of the same equations the values obey; a
  // census that never reaches one refuses, because an unsettled bound is
  // exactly the case where a `long long` and a double stop agreeing.
  let settled = false
  for (let round = 0; round < settlingRounds; round += 1) {
    const answers = censusRound()
    const next = new Map<string, IntegerMagnitude>()
    for (const slot of integral) {
      let magnitude: IntegerMagnitude | null = { kind: 'bounded', limit: 0 }
      let recursive = false
      for (const entry of bySlot.get(slot) ?? []) {
        const scan = scans.get(entry.owner)
        // A self-recursive sum is bounded by the OTHER writes, so it is skipped
        // here and applied to their join below -- reading it as arithmetic is
        // what makes the slot climb forever.
        if (scan !== undefined && selfSumOf(scan, slot, entry.value)) {
          recursive = true
          continue
        }
        const step = scan === undefined ? null : selfStepOf(scan, slot, entry.value)
        const written = step !== null ? integerLinearMagnitude(step) : (answers.get(entry.owner)?.magnitudes.get(entry.value) ?? null)
        magnitude = widenIntegerMagnitude(magnitude, written)
      }
      if (recursive && magnitude !== null)
        magnitude = integerLinearMagnitude(magnitude.kind === 'bounded' ? magnitude.limit : magnitude.coefficient)
      if (magnitude !== null) next.set(slot, magnitude)
    }
    const unchanged =
      next.size === magnitudes.size && [...next].every(([slot, magnitude]) => sameMagnitude(magnitudes.get(slot), magnitude))
    magnitudes = next
    if (unchanged) {
      settled = true
      break
    }
  }
  if (!settled) return emptyIntegerStorageCensus

  const slots = new Set(magnitudes.keys())
  const facts = new Map<string, IntegerStorageFacts>()
  for (const [owner, scan] of scans) {
    const reads = new Map<IrValueId, string>()
    for (const [value, slot] of scan.reads) if (slots.has(slot)) reads.set(value, slot)
    if (reads.size > 0) facts.set(owner, { reads, integral: slots, magnitudes })
  }
  return { slots, factsOf: (owner: FunctionId | RegionId) => facts.get(String(owner)) ?? emptyFacts }
}
