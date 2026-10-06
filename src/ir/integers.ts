import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { controlFlowGraphOf, dominatorTreeOf, naturalLoopsOf } from './dominance.js'
import type { Representation, TypedArrayElementDomain } from '../representation/model.js'
import type { ComputeOperation, IrBlockId, IrBody, IrOperand } from './model.js'
import { numericIntrinsicsOf } from './numeric-intrinsics.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * Which `number` values a body may hold in a 64-bit integer instead of a
 * double, and why the answer is a MAGNITUDE question rather than a type one.
 *
 * Every JS number is a double, so narrowing one to `long long` is only
 * observationally neutral while the two agree -- which they do exactly while
 * the value is an integer whose magnitude stays under 2^53. Above that a
 * double starts rounding and an integer does not, so the two computations
 * diverge, and the program's own answer changes. The benchmark fixtures are
 * built around precisely that: `loop_overhead` accumulates `total += i` past
 * 2^53 on purpose and its hand-written baseline keeps `total` a double to
 * reproduce node's rounded sum, and `factorial`'s `acc * i` leaves the exact
 * range within nine million iterations, which is why ITS baseline carries a
 * `p < 2^53` guard. A narrowing that reads only "is this an integer" turns
 * both of those into silently different programs.
 *
 * So each value carries how big it can get:
 *
 *   - `bounded(k)` -- never exceeds a constant `k`. A literal, a `% C`, a
 *     masked bitwise result, an array's `length`, a counter whose loop test
 *     compares it against something bounded.
 *   - `linear(c)` -- grows at most `c` per loop iteration. A counter stepping
 *     by one is `linear(1)`; `i * 3` is `linear(3)`.
 *
 * A `bounded` value narrows when its bound is under 2^53: the two carriers
 * cannot disagree. A `linear` value narrows when its coefficient is small,
 * because reaching 2^53 then costs 2^53/c iterations -- for c at or under 256
 * that is at least 2^45 turns of a loop, which no program that terminates will
 * execute. Everything else stays a double. `total += i` is a linear increment
 * of a linear value and has no coefficient at all -- it is quadratic, and 2^53
 * arrives after 2^27 iterations, so it is refused. `acc * i` multiplies a
 * value bounded by a billion by a counter, giving `linear(1000000007)`, far
 * over the cap, so it is refused too. Both keep the double their baselines
 * keep, for the same reason.
 *
 * What this deliberately does NOT model is the loop trip count as a symbol: a
 * counter bounded by a `number` PARAMETER is `linear`, not `bounded`, because
 * nothing here knows what the caller passes.
 */
export interface IntegerNarrowing {
  /** SSA values whose C++ storage may be `long long`. */
  readonly values: ReadonlySet<IrValueId>
  /** Binding cells whose C++ storage may be `long long`. Every read of one is in `values`. */
  readonly bindings: ReadonlySet<DeclarationId>
  /**
   * How large each value this body examined can get.
   *
   * Published because a whole-program census over STORAGE -- a record field, an
   * array's element -- has to widen the magnitudes of every write to one slot,
   * and those writes are in bodies this call never sees. Reading them back out
   * is what lets that census reach an answer without a second lattice of its
   * own to disagree with this one.
   */
  readonly magnitudes: ReadonlyMap<IrValueId, IntegerMagnitude>
  /**
   * Values that are integers at all, whatever their magnitude.
   *
   * Separate from `values` because the two questions settle in opposite
   * directions: integrality is an optimistic fixed point (see below) and a
   * whole-program census has to run it to convergence before any magnitude is
   * meaningful.
   */
  readonly integral: ReadonlySet<IrValueId>
  /**
   * `%` results whose dividend is an integer of ANY size and whose divisor is a
   * non-zero constant.
   *
   * Narrower than `values`, and deliberately: a remainder is bounded by its
   * divisor, so a `%` in `values` is one this body can hold in a `long long`
   * outright. This is the case one step short of that -- `acc = (acc * i) % MOD`
   * in `factorial.ts`, whose dividend runs past 2^53 and must stay a `double` --
   * where the DIVISION is still an integer one. What it buys is skipping the
   * round trip `gea::remainder` pays to discover at run time what this already
   * knows: two conversions, two equality checks and a range test, on the
   * loop-carried dependency of a modular accumulation.
   */
  readonly integralRemainders: ReadonlySet<IrValueId>
  /**
   * `%` results whose dividend AND divisor are both integers, but whose divisor
   * is not a constant this census can read -- `i % ring.length`, the shape
   * every ring buffer and hash bucket is written in.
   *
   * Distinct from `integralRemainders` because the divisor's non-zeroness is
   * the thing that cannot be settled here: `x % 0` is NaN in the language and
   * a fault in C++, so the answer stays a double and the emitted form tests the
   * divisor at run time. That test costs a perfectly predicted branch; `fmod`
   * costs a libcall.
   */
  readonly dynamicRemainders: ReadonlySet<IrValueId>
  /**
   * Narrowed `+`, `-`, `*` and update results whose magnitude is wide (see
   * `wideLinearCoefficientCap`): the integer answer may leave +-2^53, where
   * the Number rounds, so the emitter spells them with the rounding helpers
   * rather than as bare C++ arithmetic.
   */
  readonly roundingArithmetic: ReadonlySet<IrValueId>
  /**
   * `/` and `%` results computed by a guarded integer division over values
   * derived from `int`/`i32` bindings (`IntegerStorageFacts.declaredCells`): a
   * `/` whose quotient only ever lands in such a binding, whose store truncates
   * it anyway, and a `%` whose divisor is not a known non-zero constant.
   */
  readonly integerDivisions: ReadonlySet<IrValueId>
  /**
   * The narrowed values an `int`/`i32` annotation put there, each with its
   * machine width. Their `+ - *`, negation and updates WRAP at that width --
   * the annotation's contract -- rather than overflowing; an `int32` one is
   * held in an `int32_t`, the native integer of a 32-bit core.
   */
  readonly declaredWidths: ReadonlyMap<IrValueId, DeclaredIntegerWidth>
  /** Numeric views proved exact, or consumed exclusively by declared machine arithmetic. */
  readonly exactNumericConversions: ReadonlySet<IrValueId>
  /** The `int`/`i32` cells among `bindings`, with the width each is held at. */
  readonly declaredBindings: ReadonlyMap<DeclarationId, DeclaredIntegerWidth>
}

export const emptyIntegerNarrowing: IntegerNarrowing = {
  values: new Set(),
  bindings: new Set(),
  magnitudes: new Map(),
  integral: new Set(),
  integralRemainders: new Set(),
  dynamicRemainders: new Set(),
  roundingArithmetic: new Set(),
  integerDivisions: new Set(),
  declaredWidths: new Map(),
  exactNumericConversions: new Set(),
  declaredBindings: new Map()
}

/**
 * What a whole-program census over storage knows that one body cannot.
 *
 * A field of a record and an element of an Array are one storage shared by
 * every body that touches them, so whether either holds an integer is not a
 * question a single body can answer -- and it is exactly the question that
 * decides whether `total = (total + o.x + o.y + o.z) % 1000000000` is four
 * integer operations or four calls into `fmod`. The census that answers it
 * lives outside this file; what arrives here is its conclusion, keyed by
 * whatever slot identity that census uses.
 */
export interface IntegerStorageFacts {
  /** The storage slot each `get` result in this body reads, where the census identified one. */
  readonly reads: ReadonlyMap<IrValueId, string>
  /** Slots that hold an integer. */
  readonly integral: ReadonlySet<string>
  /** The magnitude each integral slot holds, where the census settled one. */
  readonly magnitudes: ReadonlyMap<string, IntegerMagnitude>
  /**
   * Call results in `reads` that are integral only while the call reaches the
   * body the census read, with the bound that body's returns settled at. A
   * guarded member call (`NumberUtils.getInt32LE(...)`) names a candidate, not
   * a proof: the field may hold another callable. The emitter checks each of
   * these against its bound where the call returns, so a callable that
   * answers otherwise stops the program instead of being truncated.
   */
  readonly guarded?: ReadonlyMap<IrValueId, number>
  /**
   * Cells the WHOLE program writes exactly once, with an integer literal --
   * `programCellConstantsOf`. A module `const PITCH = 122` is written by the
   * module body and read by every method that indexes with it; the one-write
   * rule below sees only its own body's writes, so without this a method
   * reading the cell had none and every index derived from it was a double.
   */
  readonly cellConstants?: ReadonlyMap<DeclarationId, number>
  /**
   * Cells the WHOLE program writes exactly once, with a value the writing body's
   * own census proves an integer of bounded magnitude -- `programCellIntegersOf`.
   * The generalization of `cellConstants` from a literal to `(w >> 1) | 0`: a
   * body that only READS the cell has no write to examine, so without this
   * every index built from a computed module constant was a double.
   */
  readonly cellIntegers?: ReadonlyMap<DeclarationId, IntegerMagnitude>
  /**
   * Bindings the program annotated `int` (64-bit) or `i32` (32-bit) --
   * `semantics/declared-integers.ts`. The annotation accepts integer semantics,
   * so such a cell is integer storage whatever its magnitude: a store
   * truncates, and arithmetic over it stays in the integers rather than
   * waiting for a bound this census could never prove.
   */
  readonly declaredCells?: ReadonlyMap<DeclarationId, DeclaredIntegerWidth>
}

/** The machine integer an `int`/`i32` annotation opts a binding into. */
export type DeclaredIntegerWidth = 'int64' | 'int32'

/**
 * Which cells hold one integer literal at every read, program-wide: exactly
 * one `binding-write` across all `bodies`, and its value a number constant
 * that is a safe integer.
 */
export const programCellConstantsOf = (bodies: readonly IrBody[]): ReadonlyMap<DeclarationId, number> => {
  const writes = new Map<DeclarationId, number>()
  const literal = new Map<DeclarationId, number | null>()
  for (const body of bodies) {
    const constantValues = new Map<IrValueId, number>()
    for (const blockId of body.blockOrder) {
      for (const operation of body.blocks.get(blockId)?.operations ?? []) {
        if (operation.kind === 'constant' && operation.literal === 'number') {
          const value = integerText(operation.text)
          if (value !== null) constantValues.set(operation.result.id, value)
        }
      }
    }
    for (const blockId of body.blockOrder) {
      for (const operation of body.blocks.get(blockId)?.operations ?? []) {
        if (operation.kind !== 'binding-write') continue
        writes.set(operation.declaration, (writes.get(operation.declaration) ?? 0) + 1)
        literal.set(operation.declaration, constantValues.get(operation.value.value) ?? null)
      }
    }
  }
  const constants = new Map<DeclarationId, number>()
  for (const [cell, count] of writes) {
    const value = literal.get(cell)
    if (count === 1 && value !== undefined && value !== null) constants.set(cell, value)
  }
  return constants
}

/**
 * Which cells hold an integer of a known bound at every read, program-wide:
 * exactly one `binding-write` across all `bodies`, and the writing body's
 * census proves its value integral with a BOUNDED magnitude under 2^53.
 *
 * Bounded only, never linear: the write may run many times (a loop, a function
 * called repeatedly), and only a bound holds for every execution. Exactly one
 * static write is what makes the cell's content "that expression" at every read
 * that follows it; a read that precedes it sees the cell's initial content,
 * which `eligible` restricts to cells whose placement is a number scalar
 * (zero-initialized, so 0 as a `long long` or as a double).
 *
 * Settled from below, as a least fixed point: the first round knows no cell, so
 * a writer that reads another such cell (`HALF_W = WIDTH >> 1`) joins only after
 * that cell has joined. Nothing is ever assumed and later struck, so a round
 * that stops early is merely less precise, never unsound.
 */
export const programCellIntegersOf = (
  bodies: readonly IrBody[],
  eligible: (cell: DeclarationId) => boolean,
  cellConstants: ReadonlyMap<DeclarationId, number>
): ReadonlyMap<DeclarationId, IntegerMagnitude> => {
  const writeCounts = new Map<DeclarationId, number>()
  for (const body of bodies)
    for (const blockId of body.blockOrder)
      for (const operation of body.blocks.get(blockId)?.operations ?? [])
        if (operation.kind === 'binding-write') writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
  const pending = new Map<IrBody, { readonly cell: DeclarationId; readonly value: IrOperand }[]>()
  for (const body of bodies)
    for (const blockId of body.blockOrder)
      for (const operation of body.blocks.get(blockId)?.operations ?? []) {
        if (operation.kind !== 'binding-write' || writeCounts.get(operation.declaration) !== 1) continue
        if (!isNumberScalar(operation.value) || !eligible(operation.declaration)) continue
        const writes = pending.get(body) ?? []
        writes.push({ cell: operation.declaration, value: operation.value })
        pending.set(body, writes)
      }
  const cells = new Map<DeclarationId, IntegerMagnitude>()
  for (let round = 0; round < 16 && pending.size > 0; round++) {
    let changed = false
    for (const [body, writes] of [...pending]) {
      const narrowed = narrowableIntegersOf(body, { ...noStorageFacts, cellConstants, cellIntegers: cells })
      const unresolved = writes.filter(({ cell, value }) => {
        const magnitude = narrowed.magnitudes.get(value.value)
        if (!narrowed.integral.has(value.value) || magnitude === undefined || magnitude.kind !== 'bounded') return true
        if (magnitude.limit > exactIntegerLimit) return true
        cells.set(cell, magnitude)
        changed = true
        return false
      })
      if (unresolved.length === 0) pending.delete(body)
      else pending.set(body, unresolved)
    }
    if (!changed) break
  }
  return cells
}

const noStorageFacts: IntegerStorageFacts = { reads: new Map(), integral: new Set(), magnitudes: new Map() }

/** 2^53: the last integer a double can hold with every integer below it. */
const exactIntegerLimit = 9007199254740992

/**
 * The most a narrowed value may grow per loop iteration.
 *
 * The cap is set so that reaching 2^53 costs at least 2^30 turns of a loop --
 * a billion iterations of whatever body does the growing, which no program
 * that answers in finite time runs. At 2^23 that is exactly 2^30 turns; at
 * 2^33 it would be 2^20, which a loop really can run, so the cap is not a
 * formality. It admits `checksum += data[i]` over elements bounded by a
 * million (`bench/comparison/fixtures/array_write.ts`) and still refuses
 * `factorial`'s `acc * i`, which grows by a billion a turn.
 */
const linearCoefficientCap = 1 << 23

/**
 * The most a narrowed value may grow per iteration when its arithmetic is
 * spelled to round as the Number would (`gea::faithfulIntegerSum` and its
 * siblings): the same 2^30 turns, measured against the 64-bit carrier's 2^63
 * instead of 2^53.
 *
 * Every double at or above 2^53 is an integer, and every one under 2^63 is a
 * `long long` exactly. So a sum or product whose integer answer leaves +-2^53
 * can take the rounded double answer ECMA-262 gives and go on being carried --
 * the carrier diverges from the Number only past 2^63, where the helper stops
 * the program by name. What this admits is the byte offset: a cursor advanced
 * by int32 lengths read out of the buffer (`index += size` in bson's
 * deserializer) grows by 2^32 a turn, far over the exact cap and well under
 * this one.
 */
const wideLinearCoefficientCap = 2 ** 33

export type IntegerMagnitude =
  { readonly kind: 'bounded'; readonly limit: number } | { readonly kind: 'linear'; readonly coefficient: number }
type Magnitude = IntegerMagnitude

/**
 * The largest bound the 64-bit carrier takes: under 2^63, where a `long long`
 * ends. A bound past 2^53 is carried only through the rounding spelling
 * (`isWide`), which keeps every value the Number the program would hold.
 */
const carrierIntegerLimit = 2 ** 63 - 2 ** 11

const boundedBy = (limit: number): Magnitude | null =>
  Number.isFinite(limit) && limit <= carrierIntegerLimit ? { kind: 'bounded', limit } : null

const growsBy = (coefficient: number): Magnitude | null =>
  Number.isFinite(coefficient) && coefficient <= wideLinearCoefficientCap ? { kind: 'linear', coefficient } : null

/** A magnitude only the rounding spelling keeps faithful: a bound past 2^53, or growth that reaches it in under 2^30 turns. */
const isWide = (magnitude: Magnitude | null | undefined): boolean =>
  magnitude !== null &&
  magnitude !== undefined &&
  (magnitude.kind === 'linear' ? magnitude.coefficient > linearCoefficientCap : magnitude.limit > exactIntegerLimit)

/**
 * A linear magnitude forgets the bounded base it grew from, which is sound only
 * while that base is exact: `linear(1)` over a start past 2^53 is already a
 * value the Number rounds. Such a join keeps the rounding spelling by staying
 * wide.
 */
const absorbedCoefficient = (left: Magnitude, right: Magnitude, coefficient: number): number =>
  isWide(left) || isWide(right) ? Math.max(coefficient, 2 * linearCoefficientCap) : coefficient

/**
 * A value that grows by at most `coefficient` each time the thing that produces
 * it runs again -- the same judgement `growsBy` makes for a loop counter,
 * published for the whole-program census over storage.
 *
 * A RECURSION is a loop for this purpose and the argument is the one the cap
 * was set from: `fib(n - 1)` steps its own formal by one per call, so reaching
 * 2^53 would take 2^53 nested frames and the stack ends the program first.
 */
export const integerLinearMagnitude = (coefficient: number): IntegerMagnitude | null => growsBy(coefficient)

/**
 * The worse of two magnitudes -- what a value reachable by either path can be.
 *
 * Exported because a whole-program census over STORAGE has exactly this join to
 * perform: one record field is written from many bodies, and the magnitude it
 * holds is the worse of all of them. Reusing this rather than restating it is
 * what keeps the two censuses one lattice instead of two that can disagree.
 */
export const widenIntegerMagnitude = (left: Magnitude | null, right: Magnitude | null): Magnitude | null => {
  if (left === null || right === null) return null
  if (left.kind === 'bounded' && right.kind === 'bounded') return boundedBy(Math.max(left.limit, right.limit))
  const coefficient = Math.max(left.kind === 'linear' ? left.coefficient : 0, right.kind === 'linear' ? right.coefficient : 0)
  return growsBy(absorbedCoefficient(left, right, coefficient))
}

/** The name every reader inside this file uses for the join above. */
const widen = widenIntegerMagnitude

const sum = (left: Magnitude, right: Magnitude): Magnitude | null => {
  if (left.kind === 'bounded' && right.kind === 'bounded') return boundedBy(left.limit + right.limit)
  const coefficient = (left.kind === 'linear' ? left.coefficient : 0) + (right.kind === 'linear' ? right.coefficient : 0)
  return growsBy(absorbedCoefficient(left, right, coefficient))
}

const product = (left: Magnitude, right: Magnitude): Magnitude | null => {
  if (left.kind === 'bounded' && right.kind === 'bounded') return boundedBy(left.limit * right.limit)
  // A product of two growing values is quadratic; nothing here models that.
  if (left.kind === 'linear' && right.kind === 'linear') return null
  const bounded = left.kind === 'bounded' ? left.limit : right.kind === 'bounded' ? right.limit : 0
  const growing = left.kind === 'linear' ? left.coefficient : right.kind === 'linear' ? right.coefficient : 0
  return growsBy(bounded * growing)
}

/** 2^32, the width every ECMA-262 bitwise operator reduces to before it computes. */
const bitwiseWidth = 4294967296

/**
 * 2^31: the magnitude of a signed 32-bit result. `|`, `&`, `^`, `<<`, `>>` and
 * `~` answer ToInt32 of their result, in [-2^31, 2^31); only `>>>` reaches
 * 2^32. The difference matters for products: two `| 0` int32s multiply to
 * under 2^62, which the 64-bit carrier holds, while two 2^32 bounds give 2^64
 * and refuse the whole chain -- `(cell + 1) * pitch` over a runtime grid
 * size then indexes a typed array through the double ToInt32.
 */
const int32Magnitude = 2147483648

/**
 * The largest `length` (2^40) and `byteLength`/`byteOffset` (2^43) a typed
 * array can have: the runtime's stated implementation limit
 * (`TypedArray::maxLength`/`maxByteOffset` in gea_runtime.h, enforced at every
 * construction -- the two must agree). ECMA-262 lets an engine refuse a block
 * it cannot create, so the limit is conformance, and it is what makes every
 * byte offset derived from a view's geometry a bounded integer: a sum of 2^10
 * such terms still fits under 2^53.
 */
const typedArrayGeometryLimit: ReadonlyMap<string, number> = new Map([
  ['length', 2 ** 40],
  ['byteLength', 2 ** 43],
  ['byteOffset', 2 ** 43]
])

/**
 * The magnitude of one element of an integer typed array (ECMA-262 23.2
 * Table 71): a read answers exactly the stored element, which the element
 * type's own conversion put in this range. The float views hold any double.
 */
const typedArrayElementLimit: ReadonlyMap<TypedArrayElementDomain, number> = new Map([
  ['int8', 2 ** 7],
  ['uint8', 2 ** 8 - 1],
  ['uint8-clamped', 2 ** 8 - 1],
  ['int16', 2 ** 15],
  ['uint16', 2 ** 16 - 1],
  ['int32', 2 ** 31],
  ['uint32', 2 ** 32 - 1]
])

/** The operators whose result is an integer whatever reached them (ECMA-262 6.1.6.1.2, .9-.11, .16-.19). */
const bitwiseOperators: ReadonlySet<string> = new Set(['&', '|', '^', '<<', '>>', '>>>', '~'])

/** A key constant naming an element rather than a property: `"0"`, `"17"` -- the canonical numeric strings. */
const isCanonicalIndexText = (text: string): boolean => {
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 0 && String(value) === text
}

const integerText = (text: string): number | null => {
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

/** Only the generic `number` domain: `boolean` and `bigint` are scalars too, and neither is a double this may re-carry. */
const isNumberScalar = (operand: { readonly representation: Representation }): boolean =>
  operand.representation.kind === 'scalar' && operand.representation.domain === 'number'

/**
 * The magnitude model for one body, and the narrowing it implies.
 *
 * A cell is judged as a whole -- every write into it and every read out of it
 * share one storage, so they share one answer. A counter is recognized here
 * rather than fixed up afterwards, because the recurrence `i = i + 1` is a
 * cycle: asking for its magnitude by walking its operands would ask for its
 * own magnitude, and the honest reading of that cycle is "grows by the step".
 */
export const narrowableIntegersOf = (body: IrBody, storage: IntegerStorageFacts = noStorageFacts): IntegerNarrowing => {
  // Math.imul always returns a signed int32, including for fractional, NaN,
  // infinite and overflowing inputs. Its callable ABI alone says only number.
  const imulResults = new Set<IrValueId>()
  // `Math.min`/`Math.max` of two integers is one of them: an integer exactly
  // when both arguments are, no larger than the larger of the two. Without
  // this a clamped row index (`Math.max(cell - 1, 0)`) was a double, and so
  // was every index derived from it -- soft-float on every pixel of Bloom's
  // upscaler.
  const minMaxResults = new Map<IrValueId, readonly IrOperand[]>()
  // `Math.clz32` counts the leading zeros of ToUint32 of anything, NaN
  // included: always an integer in [0, 32]. `Math.abs` of an integer is an
  // integer no larger than it. Without these a vorticity confinement's
  // `Math.abs(gx)` and `Math.clz32(length)` were doubles, and with them every
  // shift and product downstream -- soft-float per cell on the S31.
  const clz32Results = new Set<IrValueId>()
  const absResults = new Map<IrValueId, IrOperand>()
  for (const [call, intrinsic] of numericIntrinsicsOf(body).calls) {
    if (!call.result) continue
    if (intrinsic === 'imul') imulResults.add(call.result.id)
    else if (intrinsic === 'clz32') clz32Results.add(call.result.id)
    else if (intrinsic === 'abs') {
      const argument = call.arguments[0]
      if (argument) absResults.set(call.result.id, argument)
    } else minMaxResults.set(call.result.id, call.arguments)
  }
  const definitions = new Map<IrValueId, { readonly kind: string; readonly operation: unknown }>()
  const computes = new Map<IrValueId, ComputeOperation>()
  const lengthReads = new Set<IrValueId>()
  /** Typed-array geometry and integer-element reads, each with the bound its carrier guarantees. */
  const typedArrayReads = new Map<IrValueId, number>()
  const constantTexts = new Map<IrValueId, string>()
  const constants = new Map<IrValueId, number>()
  const readsCell = new Map<IrValueId, DeclarationId>()
  const cellWrites = new Map<DeclarationId, { readonly value: IrOperand; readonly block: IrBlockId }[]>()
  const cellScalar = new Map<DeclarationId, boolean>()
  const phis = new Map<IrValueId, readonly IrOperand[]>()
  const valueRepresentations = new Map<IrValueId, Representation>()
  const numericConversions = new Map<IrValueId, IrOperand>()

  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (operation.kind === 'convert' && isNumberScalar(operation.source) && isNumberScalar(operation.result))
        numericConversions.set(operation.result.id, operation.source)
      if (operation.kind === 'constant') {
        definitions.set(operation.result.id, { kind: 'constant', operation })
        constantTexts.set(operation.result.id, operation.text)
        if (operation.literal === 'number') {
          const value = integerText(operation.text)
          if (value !== null) constants.set(operation.result.id, value)
        }
        continue
      }
      if (operation.kind === 'compute') {
        definitions.set(operation.result.id, { kind: 'compute', operation })
        computes.set(operation.result.id, operation)
        continue
      }
      if (operation.kind === 'phi') {
        definitions.set(operation.result.id, { kind: 'phi', operation })
        phis.set(
          operation.result.id,
          operation.incoming.map((incoming) => incoming.value)
        )
        continue
      }
      if (operation.kind === 'binding-read') {
        definitions.set(operation.result.id, { kind: 'binding-read', operation })
        readsCell.set(operation.result.id, operation.declaration)
        cellScalar.set(operation.declaration, (cellScalar.get(operation.declaration) ?? true) && isNumberScalar(operation.result))
        continue
      }
      if (operation.kind === 'binding-write') {
        const written = cellWrites.get(operation.declaration) ?? []
        written.push({ value: operation.value, block: blockId })
        cellWrites.set(operation.declaration, written)
        cellScalar.set(operation.declaration, (cellScalar.get(operation.declaration) ?? true) && isNumberScalar(operation.value))
        continue
      }
      // An Array's own `length` is a non-negative integer under 2^32 (ECMA-262
      // 10.4.2.1 refuses any other value), so a read of one is an integer this
      // may hold in a `long long` -- and that is what makes `i % ring.length`
      // and every index derived from it an integer expression rather than a
      // pair of doubles going through `fmod`.
      if (
        operation.kind === 'get' &&
        constantTexts.get(operation.key.value) === 'length' &&
        (operation.receiver.representation.kind === 'array-object' || operation.receiver.representation.kind === 'string')
      )
        lengthReads.add(operation.result.id)
      if (operation.kind === 'get' && operation.receiver.representation.kind === 'typed-array' && isNumberScalar(operation.result)) {
        const keyText = constantTexts.get(operation.key.value)
        const limit =
          keyText !== undefined && !isCanonicalIndexText(keyText)
            ? typedArrayGeometryLimit.get(keyText)
            : typedArrayElementLimit.get(operation.receiver.representation.element)
        if (limit !== undefined) typedArrayReads.set(operation.result.id, limit)
      }
      const result = 'result' in operation ? operation.result : null
      if (result) definitions.set(result.id, { kind: operation.kind, operation })
    }
  }
  // A `const MOD = 1000000007` is a cell, not a literal, and every read of it
  // reaches here as a `binding-read`. A cell written exactly once, with a
  // literal, holds that literal at every read -- so the divisor of
  // `x % MOD` is as constant as the divisor of `x % 1000000007`, and refusing
  // the second spelling would make the lattice's answer depend on whether the
  // program named its modulus.
  for (const [value, cell] of readsCell) {
    if (constants.has(value)) continue
    const written = cellWrites.get(cell) ?? []
    const only = written.length === 1 ? written[0] : undefined
    const literal =
      only === undefined ? (written.length === 0 ? storage.cellConstants?.get(cell) : undefined) : constants.get(only.value.value)
    if (literal !== undefined) constants.set(value, literal)
  }
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      const result = 'result' in operation ? operation.result : null
      if (result) valueRepresentations.set(result.id, result.representation)
    }
  }
  const refinedReads = cellReadRefinementsOf(body, controlFlowGraphOf(body), readsCell, computes, constants, typedArrayReads)
  const isNumberScalarValue = (value: IrValueId): boolean => {
    const representation = valueRepresentations.get(value)
    return representation !== undefined && representation.kind === 'scalar' && representation.domain === 'number'
  }

  const graph = controlFlowGraphOf(body)
  const dominance = dominatorTreeOf(body)
  const loops = naturalLoopsOf(graph, dominance)

  /**
   * Which values are integers at all, settled OPTIMISTICALLY before any
   * magnitude is asked for.
   *
   * Integrality is a cyclic question -- `h = (h + i * 3 + 1) % C` is an integer
   * exactly when `h` is -- and a walk that answered "not an integer" on
   * re-entry would refuse every accumulator in the language. Assuming every
   * `number` is an integer and striking out the ones a definition disproves
   * reaches the greatest fixed point instead, which for a cycle with no
   * non-integer anywhere in it is the right answer.
   */
  const integral = new Set<IrValueId>()
  const integralCells = new Set<DeclarationId>()
  for (const value of valueRepresentations.keys()) if (isNumberScalarValue(value)) integral.add(value)
  for (const [cell, scalar] of cellScalar) if (scalar) integralCells.add(cell)
  const declaredCells = storage.declaredCells ?? new Map<DeclarationId, DeclaredIntegerWidth>()
  // A store into a declared cell truncates, so the cell is an integer whatever is written.
  for (const cell of cellScalar.keys()) if (declaredCells.has(cell)) integralCells.add(cell)

  const producesInteger = (value: IrValueId): boolean => {
    const carrier = valueRepresentations.get(value)
    if (carrier?.kind === 'scalar' && carrier.integerWidth !== undefined) return true
    const converted = numericConversions.get(value)
    if (converted !== undefined) return integral.has(converted.value)
    if (imulResults.has(value) || clz32Results.has(value)) return true
    const absolute = absResults.get(value)
    if (absolute !== undefined) return integral.has(absolute.value)
    const chosen = minMaxResults.get(value)
    if (chosen !== undefined) return chosen.every((argument) => integral.has(argument.value))
    if (constants.has(value)) return true
    if (lengthReads.has(value)) return true
    if (typedArrayReads.has(value)) return true
    // A read of storage a whole-program census settled. Asked before the
    // definition kinds below because the operation that produced it is a `get`,
    // which none of them models -- without this it falls through to `return
    // false` and every field of every record is a double.
    const slot = storage.reads.get(value)
    if (slot !== undefined) return storage.integral.has(slot)
    // A read the flow refinement bounded by a completed typed-array index is
    // an integer whatever else the cell was ever given: a fractional key
    // aborts that read (`TypedArray::requireIndex`), so no path reaches here
    // holding one. A read that sees one particular write is that write.
    const refinement = refinedReads.get(value)
    if (refinement?.kind === 'bounded') return true
    if (refinement?.kind === 'forward') return integral.has(refinement.value.value)
    const cell = readsCell.get(value)
    if (cell !== undefined) return integralCells.has(cell)
    const incoming = phis.get(value)
    if (incoming !== undefined) return incoming.every((operand) => integral.has(operand.value))
    const compute = computes.get(value)
    if (!compute) return false
    const [left, right] = compute.operands
    if (!left) return false
    // Every bitwise operator runs ToInt32/ToUint32 on both sides first, so its
    // result is an integer no matter what reached it.
    if (bitwiseOperators.has(compute.operator) && (compute.form === 'binary' || compute.form === 'unary')) return true
    if (compute.form === 'update') return integral.has(left.value)
    if (compute.form === 'unary') {
      if (compute.operator !== '-' && compute.operator !== '+') return false
      // Negating a zero this census can SEE is the one negation whose result a
      // 64-bit integer cannot carry. `-0` is an integer by every arithmetic
      // test -- `Number.isSafeInteger(-0)` is true and `-0 === 0` -- so nothing
      // else here strikes it; but two's complement has a single zero, and the
      // sign is gone at the store. ECMA-262 can read that sign back
      // (`Object.is(x, -0)` is true where `Object.is(x, 0)` is false, and
      // `1 / -0` is `-Infinity`), so a slot narrowed on the strength of a `-0`
      // answers both the other way with no diagnostic. `emit.ts` already
      // spells this operand `-0.0` for exactly that reason; the value it
      // carefully produces is then rounded away by the storage this census
      // hands out.
      //
      // Only the statically visible one is refused. A `-0` that arises at
      // runtime -- `x * -1`, `-1 % 1`, `x - x` never, but `x * y` with either
      // zero -- is the same class of hazard as an overflowing sum, which this
      // design already tolerates: refusing every product and remainder that
      // COULD be a negative zero would narrow nothing at all.
      if (compute.operator === '-' && constants.get(left.value) === 0) return false
      return integral.has(left.value)
    }
    if (compute.form !== 'binary' || !right) return false
    if (compute.operator === '%') {
      const divisor = constants.get(right.value)
      return divisor !== undefined && divisor !== 0 && integral.has(left.value)
    }
    if (compute.operator !== '+' && compute.operator !== '-' && compute.operator !== '*') return false
    return integral.has(left.value) && integral.has(right.value)
  }

  for (let settling = true; settling;) {
    settling = false
    for (const value of [...integral]) {
      if (producesInteger(value)) continue
      integral.delete(value)
      settling = true
    }
    for (const cell of [...integralCells]) {
      if (declaredCells.has(cell)) continue
      if ((cellWrites.get(cell) ?? []).every((write) => integral.has(write.value.value))) continue
      integralCells.delete(cell)
      settling = true
    }
  }

  const valueMagnitudes = new Map<IrValueId, Magnitude | null>()
  const cellMagnitudes = new Map<DeclarationId, Magnitude | null>()
  const openValues = new Set<IrValueId>()
  const openCells = new Set<DeclarationId>()

  /** `x + k` / `x - k` / `x++` where `x` reads `cell`: the step of a recurrence, or `null`. */
  const stepOverCell = (value: IrOperand, cell: DeclarationId): Magnitude | null => {
    const compute = computes.get(value.value)
    if (!compute) return null
    // A read the flow refinement already bounded is not the cell's own
    // magnitude: the write through it is a seed like any other, and asking for
    // it does not ask for the cell.
    const readsItself = (value: IrValueId): boolean => readsCell.get(value) === cell && !refinedReads.has(value)
    if (compute.form === 'update') {
      const target = compute.operands[0]
      return target && readsItself(target.value) ? { kind: 'bounded', limit: 1 } : null
    }
    if (compute.form !== 'binary' || (compute.operator !== '+' && compute.operator !== '-')) return null
    const [left, right] = compute.operands
    if (!left || !right) return null
    const self = readsItself(left.value) ? right : readsItself(right.value) ? left : null
    if (!self) return null
    const step = magnitudeOfValue(self)
    return step !== null && step.kind === 'bounded' ? step : null
  }

  /**
   * The constant a loop's own test holds this cell under, if it has one.
   *
   * Only the header's branch counts. A comparison anywhere else in the body is
   * a question the program asked, not a bound the loop enforces: `if (i < 10)`
   * inside an unbounded loop says nothing about how large `i` gets.
   */
  const loopBoundOfCell = (cell: DeclarationId, steps: readonly IrBlockId[]): Magnitude | null => {
    for (const loop of loops) {
      if (!steps.every((block) => loop.blocks.has(block))) continue
      const header = body.blocks.get(loop.header)
      if (header?.terminator.kind !== 'branch') continue
      const test = computes.get(header.terminator.condition.value)
      if (test?.form !== 'binary' || (test.operator !== '<' && test.operator !== '<=' && test.operator !== '>' && test.operator !== '>='))
        continue
      const [left, right] = test.operands
      if (!left || !right) continue
      /** Whether this operand is a read of the cell itself. */
      const namesCell = (value: IrValueId): boolean => readsCell.get(value) === cell
      /** Whether this operand is `cell * cell` -- the sieve's own loop test. */
      const isSquare = (value: IrValueId): boolean => {
        const square = computes.get(value)
        return square?.form === 'binary' && square.operator === '*' && square.operands.every((side) => namesCell(side.value))
      }
      const leftHolds = namesCell(left.value) || isSquare(left.value)
      const against = leftHolds ? right : namesCell(right.value) || isSquare(right.value) ? left : null
      if (!against) continue
      const limit = magnitudeOfValue(against)
      if (limit === null || limit.kind !== 'bounded') continue
      // `i * i <= LIMIT` bounds `i` at the square root, not at LIMIT. The
      // sieve idiom is written that way, and reading the comparison as a bound
      // on the PRODUCT leaves the loop counter unbounded -- which then leaves
      // the inner `j = i * i; j += i` counter unbounded too, so a sieve over
      // ten million entries indexes its own array with two doubles.
      const bound = isSquare(leftHolds ? left.value : right.value) ? boundedBy(Math.ceil(Math.sqrt(limit.limit))) : limit
      if (bound !== null) return bound
    }
    return null
  }

  const magnitudeOfCell = (cell: DeclarationId): Magnitude | null => {
    const known = cellMagnitudes.get(cell)
    if (known !== undefined) return known
    if (openCells.has(cell)) return null
    if (!integralCells.has(cell)) {
      cellMagnitudes.set(cell, null)
      return null
    }
    openCells.add(cell)
    const written = cellWrites.get(cell) ?? []
    // A cell this body never writes is whatever the rest of the program wrote
    // into it: nothing, unless the program-wide census proved its one write.
    let seeds: Magnitude | null = written.length > 0 ? { kind: 'bounded', limit: 0 } : (storage.cellIntegers?.get(cell) ?? null)
    let step: Magnitude | null = null
    const stepBlocks: IrBlockId[] = []
    for (const write of written) {
      const recurrence = stepOverCell(write.value, cell)
      if (recurrence !== null) {
        step = step === null ? recurrence : widen(step, recurrence)
        stepBlocks.push(write.block)
        continue
      }
      seeds = seeds === null ? null : widen(seeds, magnitudeOfValue(write.value))
    }
    openCells.delete(cell)
    let answer: Magnitude | null = seeds
    if (answer !== null && step !== null) {
      const bound = step.kind === 'bounded' ? loopBoundOfCell(cell, stepBlocks) : null
      answer =
        bound !== null
          ? widen(answer, sum(bound, step))
          : widen(answer, growsBy(step.kind === 'bounded' ? step.limit : Number.POSITIVE_INFINITY))
    }
    cellMagnitudes.set(cell, answer)
    return answer
  }

  function magnitudeOfValue(operand: IrOperand): Magnitude | null {
    const known = valueMagnitudes.get(operand.value)
    if (known !== undefined) return known
    if (!isNumberScalar(operand) || !integral.has(operand.value)) return null
    if (openValues.has(operand.value)) return null
    openValues.add(operand.value)
    const answer = computeMagnitude(operand)
    openValues.delete(operand.value)
    valueMagnitudes.set(operand.value, answer)
    return answer
  }

  const computeMagnitude = (operand: IrOperand): Magnitude | null => {
    if (operand.representation.kind === 'scalar' && operand.representation.integerWidth === 'int32') return boundedBy(2 ** 31)
    const converted = numericConversions.get(operand.value)
    if (converted !== undefined) return magnitudeOfValue(converted)
    if (imulResults.has(operand.value)) return boundedBy(2 ** 31)
    if (clz32Results.has(operand.value)) return boundedBy(32)
    const absolute = absResults.get(operand.value)
    if (absolute !== undefined) return magnitudeOfValue(absolute)
    const chosen = minMaxResults.get(operand.value)
    if (chosen !== undefined) {
      let answer: Magnitude | null = { kind: 'bounded', limit: 0 }
      for (const argument of chosen) answer = widen(answer, magnitudeOfValue(argument))
      return answer
    }
    const constant = constants.get(operand.value)
    if (constant !== undefined) return boundedBy(Math.abs(constant))
    if (lengthReads.has(operand.value)) return boundedBy(bitwiseWidth)
    const typedArrayLimit = typedArrayReads.get(operand.value)
    if (typedArrayLimit !== undefined) return boundedBy(typedArrayLimit)
    const slot = storage.reads.get(operand.value)
    if (slot !== undefined) return storage.magnitudes.get(slot) ?? null
    const refinement = refinedReads.get(operand.value)
    if (refinement !== undefined) {
      if (refinement.kind === 'bounded') return boundedBy(refinement.limit)
      // The value the one reaching write stored, when it is an integer this
      // census examined; a write of anything else leaves the cell's own answer.
      if (integral.has(refinement.value.value)) return magnitudeOfValue(refinement.value)
    }
    const cell = readsCell.get(operand.value)
    if (cell !== undefined) return magnitudeOfCell(cell)
    const incoming = phis.get(operand.value)
    if (incoming !== undefined) {
      let answer: Magnitude | null = { kind: 'bounded', limit: 0 }
      for (const value of incoming) answer = widen(answer, magnitudeOfValue(value))
      return answer
    }
    const compute = computes.get(operand.value)
    if (!compute) return null
    return magnitudeOfCompute(compute)
  }

  const magnitudeOfCompute = (compute: ComputeOperation): Magnitude | null => {
    const [left, right] = compute.operands
    if (!left) return null
    if (compute.form === 'update') {
      const target = magnitudeOfValue(left)
      return target === null ? null : sum(target, { kind: 'bounded', limit: 1 })
    }
    if (compute.form === 'unary') {
      // `-x` and `+x` keep the magnitude; `~x` is a 32-bit result like every
      // other bitwise operator.
      if (compute.operator === '~') return boundedBy(int32Magnitude)
      if (compute.operator !== '-' && compute.operator !== '+') return null
      return magnitudeOfValue(left)
    }
    if (compute.form !== 'binary' || !right) return null
    switch (compute.operator) {
      case '&': {
        // A mask by a non-negative constant bounds the result at the mask; any
        // other AND is still a 32-bit quantity.
        const mask = constants.get(right.value) ?? constants.get(left.value)
        return mask !== undefined && mask >= 0 ? boundedBy(mask) : boundedBy(int32Magnitude)
      }
      case '|':
      case '^':
      case '<<':
      case '>>':
        return boundedBy(int32Magnitude)
      case '>>>':
        return boundedBy(bitwiseWidth)
      case '+':
      case '-': {
        const a = magnitudeOfValue(left)
        const b = magnitudeOfValue(right)
        return a === null || b === null ? null : sum(a, b)
      }
      case '*': {
        const a = magnitudeOfValue(left)
        const b = magnitudeOfValue(right)
        return a === null || b === null ? null : product(a, b)
      }
      case '%': {
        // The DIVISOR alone bounds a remainder, whatever the dividend was.
        // That is what breaks the cycle in `h = (h + ...) % C`: the cell's
        // magnitude does not depend on its own previous magnitude, so asking
        // for it does not ask for itself. Whether the dividend is an integer at
        // all is settled by the integrality pass above, which handles that
        // cycle optimistically; here it is already known.
        const divisor = constants.get(right.value)
        if (divisor === undefined || divisor === 0) return null
        return boundedBy(Math.abs(divisor))
      }
      default:
        return null
    }
  }

  const declared = declaredIntegerValuesOf(
    body,
    declaredCells,
    readsCell,
    computes,
    phis,
    numericConversions,
    valueRepresentations,
    integral,
    constants,
    isNumberScalarValue
  )

  const values = new Set<IrValueId>(declared.values)
  const bindings = new Set<DeclarationId>()
  const declaredBindings = new Map<DeclarationId, DeclaredIntegerWidth>()
  for (const [cell, width] of declaredCells) {
    if (!cellScalar.has(cell)) continue
    bindings.add(cell)
    declaredBindings.set(cell, width)
  }
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      const result = 'result' in operation ? operation.result : null
      if (!result || !isNumberScalar(result)) continue
      if (magnitudeOfValue({ value: result.id, representation: result.representation }) !== null) values.add(result.id)
    }
  }
  for (const cell of cellWrites.keys()) {
    if (magnitudeOfCell(cell) !== null) bindings.add(cell)
  }
  // A cell stored as `long long` program-wide (its one write proved integral)
  // is integer storage in every body that reads it, whether or not it writes.
  for (const cell of readsCell.values()) {
    if (storage.cellIntegers?.has(cell) === true && magnitudeOfCell(cell) !== null) bindings.add(cell)
  }
  // Only the values that HAVE a magnitude: `valueMagnitudes` records a refusal
  // as `null`, and a consumer reading one back would take "refused" for
  // "unknown" and re-derive it.
  const magnitudes = new Map<IrValueId, IntegerMagnitude>()
  for (const [value, magnitude] of valueMagnitudes) if (magnitude !== null) magnitudes.set(value, magnitude)
  const integralRemainders = new Set<IrValueId>()
  for (const [result, compute] of computes) {
    if (compute.operator !== '%' || compute.form !== 'binary') continue
    const [left, right] = compute.operands
    if (!left || !right || !integral.has(left.value)) continue
    const divisor = constants.get(right.value)
    if (divisor === undefined || divisor === 0) continue
    integralRemainders.add(result)
  }
  const dynamicRemainders = new Set<IrValueId>()
  for (const [result, compute] of computes) {
    if (compute.operator !== '%' || compute.form !== 'binary') continue
    if (integralRemainders.has(result)) continue
    const [left, right] = compute.operands
    if (!left || !right) continue
    if (!integral.has(left.value) || !integral.has(right.value)) continue
    dynamicRemainders.add(result)
  }
  const roundingArithmetic = new Set<IrValueId>()
  for (const [result, compute] of computes) {
    if (!values.has(result) || declared.values.has(result) || !isWide(valueMagnitudes.get(result))) continue
    if (
      compute.form === 'update' ||
      (compute.form === 'binary' && (compute.operator === '+' || compute.operator === '-' || compute.operator === '*'))
    )
      roundingArithmetic.add(result)
  }
  const exactNumericConversions = new Set<IrValueId>()
  for (const [value, source] of numericConversions) {
    const target = valueRepresentations.get(value)
    if (target?.kind !== 'scalar' || target.integerWidth !== undefined) continue
    const bound = valueMagnitudes.get(source.value)
    if ((bound?.kind === 'bounded' && bound.limit <= exactIntegerLimit) || declared.values.has(value)) exactNumericConversions.add(value)
  }
  return {
    values,
    bindings,
    magnitudes,
    integral,
    integralRemainders,
    dynamicRemainders,
    roundingArithmetic,
    integerDivisions: declared.divisions,
    declaredWidths: declared.widths,
    exactNumericConversions,
    declaredBindings
  }
}

/**
 * The values a body computes from `int`/`i32` bindings, held in the integer
 * the annotation chose.
 *
 * The magnitude census above narrows only what it can bound, which is the right
 * default and the wrong answer for a program that has already said it wants
 * integers: `v = v % 2 === 0 ? v / 2 : 3 * v + 1` has no bound at all. Here a
 * value narrows when it is DERIVED from a declared cell -- a read of one, or
 * `+ - * %`, negation, an update or a phi over such a value -- and every other
 * operand is an integer too. `/` joins only where its quotient lands nowhere
 * but declared cells: those truncate it at the store, so dividing in the
 * integers gives the same answer, and anywhere else `7 / 2` is still 3.5.
 */
const declaredIntegerValuesOf = (
  body: IrBody,
  declaredCells: ReadonlyMap<DeclarationId, DeclaredIntegerWidth>,
  readsCell: ReadonlyMap<IrValueId, DeclarationId>,
  computes: ReadonlyMap<IrValueId, ComputeOperation>,
  phis: ReadonlyMap<IrValueId, readonly IrOperand[]>,
  numericConversions: ReadonlyMap<IrValueId, IrOperand>,
  valueRepresentations: ReadonlyMap<IrValueId, Representation>,
  integral: ReadonlySet<IrValueId>,
  constants: ReadonlyMap<IrValueId, number>,
  isNumberScalarValue: (value: IrValueId) => boolean
): {
  readonly values: ReadonlySet<IrValueId>
  readonly divisions: ReadonlySet<IrValueId>
  readonly widths: ReadonlyMap<IrValueId, DeclaredIntegerWidth>
} => {
  const arithmetic: ReadonlySet<string> = new Set(['+', '-', '*', '%', '/'])
  const operandsOf = (value: IrValueId): readonly IrOperand[] | null => {
    const converted = numericConversions.get(value)
    if (converted !== undefined) return [converted]
    const incoming = phis.get(value)
    if (incoming !== undefined) return incoming
    const compute = computes.get(value)
    if (!compute) return null
    if (compute.form === 'binary' && arithmetic.has(compute.operator)) return compute.operands
    if (compute.form === 'update') return compute.operands
    if (compute.form === 'unary' && (compute.operator === '-' || compute.operator === '+')) return compute.operands
    return null
  }
  const declaredRead = (value: IrValueId): boolean => {
    const cell = readsCell.get(value)
    return cell !== undefined && declaredCells.has(cell)
  }

  // Who consumes each value: a `/` qualifies only when every consumer is a
  // declared store or a phi that itself only reaches declared stores.
  const consumers = new Map<
    IrValueId,
    { readonly phi: IrValueId | null; readonly store: DeclarationId | null; readonly arithmetic?: IrValueId }[]
  >()
  const consumed = (
    value: IrValueId,
    use: { readonly phi: IrValueId | null; readonly store: DeclarationId | null; readonly arithmetic?: IrValueId }
  ): void => {
    const list = consumers.get(value) ?? []
    list.push(use)
    consumers.set(value, list)
  }
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of [...block.operations, block.terminator]) {
      if (operation.kind === 'convert' && numericConversions.has(operation.result.id)) {
        consumed(operation.source.value, { phi: operation.result.id, store: null })
        continue
      }
      if (operation.kind === 'phi') {
        for (const incoming of operation.incoming) consumed(incoming.value.value, { phi: operation.result.id, store: null })
        continue
      }
      if (operation.kind === 'binding-write') {
        consumed(operation.value.value, { phi: null, store: operation.declaration })
        continue
      }
      if (operation.kind === 'compute' && operandsOf(operation.result.id) !== null) {
        for (const operand of operandsOfIrOperation(operation))
          consumed(operand.value, { phi: null, store: null, arithmetic: operation.result.id })
        continue
      }
      for (const operand of operandsOfIrOperation(operation)) consumed(operand.value, { phi: null, store: null })
    }
  }
  const landsOnlyInDeclared = (value: IrValueId, seen: Set<IrValueId> = new Set()): boolean => {
    if (seen.has(value)) return true
    seen.add(value)
    const uses = consumers.get(value) ?? []
    return (
      uses.length > 0 &&
      uses.every((use) =>
        use.store !== null ? declaredCells.has(use.store) : use.phi !== null ? landsOnlyInDeclared(use.phi, seen) : false
      )
    )
  }

  // Derived: reachable forward from a declared read.
  const derived = new Set<IrValueId>()
  for (const [value, carrier] of valueRepresentations)
    if (carrier.kind === 'scalar' && carrier.integerWidth !== undefined) derived.add(value)
  for (const value of readsCell.keys()) if (declaredRead(value) && isNumberScalarValue(value)) derived.add(value)
  for (let growing = true; growing;) {
    growing = false
    for (const value of [...computes.keys(), ...phis.keys(), ...numericConversions.keys()]) {
      if (derived.has(value) || !isNumberScalarValue(value)) continue
      const operands = operandsOf(value)
      if (operands?.some((operand) => derived.has(operand.value))) {
        derived.add(value)
        growing = true
      }
    }
  }
  // Then strike, to the greatest fixed point, any whose other operands are not integers.
  const held = new Set(derived)
  const integer = (value: IrValueId): boolean => held.has(value) || integral.has(value)
  for (let settling = true; settling;) {
    settling = false
    for (const value of [...held]) {
      if (declaredRead(value)) continue
      const operands = operandsOf(value)
      const compute = computes.get(value)
      const keeps =
        operands !== null &&
        operands.every((operand) => integer(operand.value)) &&
        (compute?.operator !== '/' || landsOnlyInDeclared(value))
      const carrier = valueRepresentations.get(value)
      const machineView =
        !numericConversions.has(value) ||
        (carrier?.kind === 'scalar' && carrier.integerWidth !== undefined) ||
        ((consumers.get(value)?.length ?? 0) > 0 &&
          consumers
            .get(value)!
            .every((use) =>
              use.store !== null
                ? declaredCells.has(use.store)
                : held.has(use.arithmetic ?? use.phi ?? value) && (use.arithmetic !== undefined || use.phi !== null)
            ))
      if (keeps && machineView) continue
      held.delete(value)
      settling = true
    }
  }
  // Every `/`, and every `%` whose divisor is not a known non-zero constant (the
  // narrowed `%` assumes one), takes the guarded integer helper.
  const divisions = new Set<IrValueId>()
  for (const value of held) {
    const compute = computes.get(value)
    if (compute?.operator === '/') divisions.add(value)
    if (compute?.operator === '%' && compute.form === 'binary') {
      const divisor = compute.operands[1] === undefined ? undefined : constants.get(compute.operands[1].value)
      if (divisor === undefined || divisor === 0) divisions.add(value)
    }
  }
  // A value is 32 bits wide when everything it is computed from is: an `i32`
  // read, another 32-bit value, or a constant inside int32. Anything touching a
  // 64-bit operand is 64 bits -- the wider integer holds every answer the
  // narrower one does. Optimistic, so a phi cycle over `i32` reads stays 32.
  const int32Range = (value: IrValueId): boolean => {
    const constant = constants.get(value)
    return constant !== undefined && constant >= -2147483648 && constant <= 2147483647
  }
  const narrow = new Set<IrValueId>()
  for (const value of held) if (!declaredRead(value) || declaredCells.get(readsCell.get(value)!) === 'int32') narrow.add(value)
  for (let settling = true; settling;) {
    settling = false
    for (const value of [...narrow]) {
      if (declaredRead(value)) continue
      const carrier = valueRepresentations.get(value)
      if (carrier?.kind === 'scalar' && carrier.integerWidth === 'int32') continue
      if (carrier?.kind === 'scalar' && carrier.integerWidth === 'int64') {
        narrow.delete(value)
        settling = true
        continue
      }
      const operands = operandsOf(value) ?? []
      if (operands.every((operand) => narrow.has(operand.value) || int32Range(operand.value))) continue
      narrow.delete(value)
      settling = true
    }
  }
  const widths = new Map<IrValueId, DeclaredIntegerWidth>()
  for (const value of held) widths.set(value, narrow.has(value) ? 'int32' : 'int64')
  return { values: held, divisions, widths }
}

/**
 * Which spelling of `%` an operation gets, or `null` for the general one.
 *
 * `'narrowed'`: both sides are held in a `long long`, so C++'s own `%` is the
 * answer -- ECMA-262 6.1.6.1.6 truncates toward zero exactly as C++ does.
 * `'restated'` and `'dynamic'` are the two integer-valued-but-not-narrowed
 * cases the census separates (`ir/integers.ts`); everything else keeps
 * `gea::remainder`, which rediscovers at run time what neither could prove.
 */
/** The two cheaper `%` spellings the census settled, as the emitter records them: one pass, so `emit.ts` states the wiring once. */
export const remainderFormGroups = (
  narrowed: IntegerNarrowing
): readonly (readonly [form: 'restated' | 'dynamic', values: ReadonlySet<IrValueId>])[] => [
  ['restated', narrowed.integralRemainders],
  ['dynamic', narrowed.dynamicRemainders]
]

/** What the flow refinement knows about one read of a cell. */
type CellReadRefinement =
  | { readonly kind: 'bounded'; readonly limit: number }
  /** The read sees exactly the value this operand wrote. */
  | { readonly kind: 'forward'; readonly value: IrOperand }

interface CellFact {
  /** The cell's value was the key of a typed-array element read that completed, and has not been written since. */
  readonly bound: number | null
  /** The one write every path to here last performed. */
  readonly holds: IrOperand | null
}

/**
 * Per-read magnitude facts that the whole-cell answer cannot see, because
 * they hold at a point in the body rather than over the cell's whole life.
 *
 * The cell answer widens every write into one magnitude, and a write through a
 * read of the cell itself -- `offset += nameLength + 1` -- is a recurrence it
 * can only bound by the loop's own test or by a small per-iteration step. The
 * byte loops every binary format is written in fail both: the step is a length
 * read out of the data, and the loop test compares against another. What
 * bounds them is the typed-array READ each iteration performs:
 *
 *   - `bounded`: a completed non-optional typed-array element read proves its
 *     key was an index into the view -- `TypedArray::elementAt` aborts on any
 *     other key, since a `number` result cannot answer `undefined` -- and a
 *     view is at most `typedArrayGeometryLimit.length` long. Until the cell is
 *     written again, every read of it is that bounded index. A key of
 *     `x + k`/`x - k` bounds `x` within `k` of the same range.
 *   - `forward`: when every path to a read last wrote the same value into the
 *     cell, the read IS that value, and has that value's magnitude.
 *
 * A forward dataflow over the body's CFG: facts are generated at those two
 * points, killed by any other operation that names the cell, and met by
 * intersection. A block no edge reaches -- the entry, a catch or finally clause
 * the C++ rendering enters by unwinding -- starts with no facts at all, which
 * is what keeps an exception thrown between a write and a read from carrying a
 * stale fact into the handler.
 *
 * Only a cell this body alone writes takes part. A shared (`boxed`) or
 * captured cell can be written by another body during any call, and a fact
 * about it would outlive the write.
 */
const cellReadRefinementsOf = (
  body: IrBody,
  graph: ReturnType<typeof controlFlowGraphOf>,
  readsCell: ReadonlyMap<IrValueId, DeclarationId>,
  computes: ReadonlyMap<IrValueId, ComputeOperation>,
  constants: ReadonlyMap<IrValueId, number>,
  typedArrayReads: ReadonlyMap<IrValueId, number>
): ReadonlyMap<IrValueId, CellReadRefinement> => {
  const refinements = new Map<IrValueId, CellReadRefinement>()
  const facts = body.facts
  if (facts === undefined) return refinements
  const captured = new Set<DeclarationId>(facts.capturedDeclarations)
  const eligible = (cell: DeclarationId): boolean => !facts.boxed.has(cell) && !captured.has(cell)
  const indexLimit = typedArrayGeometryLimit.get('length') ?? 0
  type State = Map<DeclarationId, CellFact>

  /** The cell a typed-array key reads, and how far the key may sit from it. */
  const keyedCell = (key: IrOperand): { readonly cell: DeclarationId; readonly read: IrValueId; readonly offset: number } | null => {
    const direct = readsCell.get(key.value)
    if (direct !== undefined) return { cell: direct, read: key.value, offset: 0 }
    const compute = computes.get(key.value)
    if (compute?.form !== 'binary' || (compute.operator !== '+' && compute.operator !== '-')) return null
    const [left, right] = compute.operands
    if (!left || !right) return null
    const leftCell = readsCell.get(left.value)
    const rightConstant = constants.get(right.value)
    if (leftCell !== undefined && rightConstant !== undefined) return { cell: leftCell, read: left.value, offset: Math.abs(rightConstant) }
    const rightCell = readsCell.get(right.value)
    const leftConstant = constants.get(left.value)
    if (compute.operator === '+' && rightCell !== undefined && leftConstant !== undefined)
      return { cell: rightCell, read: right.value, offset: Math.abs(leftConstant) }
    return null
  }

  /** A write of `read ± constant` for a read taken since the last write: that read, at its distance from what the cell now holds. */
  const shiftOf = (written: IrValueId, reads: ReadonlyMap<IrValueId, number> | undefined): readonly [IrValueId, number] | null => {
    if (reads === undefined) return null
    const compute = computes.get(written)
    if (compute?.form !== 'binary' || (compute.operator !== '+' && compute.operator !== '-')) return null
    const [left, right] = compute.operands
    if (!left || !right) return null
    const sign = compute.operator === '+' ? 1 : -1
    // The cell now holds `read ± constant`, whatever the read's distance from
    // the content it replaced: the distance is the constant alone.
    const rightConstant = constants.get(right.value)
    if (reads.has(left.value) && rightConstant !== undefined) return [left.value, sign * rightConstant]
    const leftConstant = constants.get(left.value)
    if (compute.operator === '+' && reads.has(right.value) && leftConstant !== undefined) return [right.value, leftConstant]
    return null
  }

  const transfer = (blockId: IrBlockId, entry: State, record: boolean): State => {
    const state: State = new Map(entry)
    // The reads of each cell taken in this block, each with how far the cell's
    // CURRENT content sits from it. A key bounds the value it was computed
    // from, so it bounds the cell only through that distance: `v = i; a[v]`
    // is distance 0, `v = i; i = v + 1; a[v]` (`a[i++]`) is 1, and a write of
    // anything else leaves no read that says what `i` holds.
    const current = new Map<DeclarationId, Map<IrValueId, number>>()
    for (const operation of body.blocks.get(blockId)?.operations ?? []) {
      if (operation.kind === 'binding-read') {
        const reads = current.get(operation.declaration) ?? new Map<IrValueId, number>()
        reads.set(operation.result.id, 0)
        current.set(operation.declaration, reads)
        const fact = state.get(operation.declaration)
        if (record && fact !== undefined) {
          if (fact.bound !== null) refinements.set(operation.result.id, { kind: 'bounded', limit: fact.bound })
          else if (fact.holds !== null) refinements.set(operation.result.id, { kind: 'forward', value: fact.holds })
        }
        continue
      }
      if (operation.kind === 'binding-write') {
        const shifted = shiftOf(operation.value.value, current.get(operation.declaration))
        if (shifted === null) current.delete(operation.declaration)
        else current.set(operation.declaration, new Map([shifted]))
        if (eligible(operation.declaration)) state.set(operation.declaration, { bound: null, holds: operation.value })
        else state.delete(operation.declaration)
        continue
      }
      if ('declaration' in operation && typeof operation.declaration === 'string') {
        current.delete(operation.declaration as DeclarationId)
        state.delete(operation.declaration as DeclarationId)
        continue
      }
      if (
        operation.kind === 'get' &&
        typedArrayReads.has(operation.result.id) &&
        operation.receiver.representation.kind === 'typed-array'
      ) {
        const keyed = keyedCell(operation.key)
        const distance = keyed === null ? undefined : current.get(keyed.cell)?.get(keyed.read)
        if (keyed === null || distance === undefined || !eligible(keyed.cell)) continue
        const limit = indexLimit + keyed.offset + Math.abs(distance)
        const known = state.get(keyed.cell)
        state.set(keyed.cell, { bound: known?.bound != null ? Math.min(known.bound, limit) : limit, holds: known?.holds ?? null })
      }
    }
    return state
  }

  const meet = (states: readonly State[]): State => {
    const [first, ...rest] = states
    if (first === undefined) return new Map()
    const met: State = new Map()
    for (const [cell, fact] of first) {
      let bound = fact.bound
      let holds = fact.holds
      let present = true
      for (const other of rest) {
        const theirs = other.get(cell)
        if (theirs === undefined) {
          present = false
          break
        }
        bound = bound !== null && theirs.bound !== null ? Math.max(bound, theirs.bound) : null
        holds = holds !== null && theirs.holds !== null && holds.value === theirs.holds.value ? holds : null
      }
      if (present && (bound !== null || holds !== null)) met.set(cell, { bound, holds })
    }
    return met
  }

  // Optimistic: a predecessor not yet visited contributes nothing to the meet,
  // and facts only ever shrink, so the iteration reaches the greatest fixed
  // point. The entry and every block no edge reaches start empty.
  const exits = new Map<IrBlockId, State>()
  // `null` while no predecessor has been visited: the block is not yet known
  // reachable, which is TOP, not "no facts" -- treating it as empty would let a
  // later round GROW its state and the iteration would never settle.
  const entryOf = (blockId: IrBlockId): State | null => {
    const predecessors = graph.predecessors.get(blockId) ?? []
    if (blockId === body.entry || predecessors.length === 0) return new Map()
    const visited = predecessors.map((predecessor) => exits.get(predecessor)).filter((state): state is State => state !== undefined)
    return visited.length === 0 ? null : meet(visited)
  }
  const sameState = (left: State | undefined, right: State): boolean => {
    if (left === undefined || left.size !== right.size) return false
    for (const [cell, fact] of right) {
      const theirs = left.get(cell)
      if (theirs === undefined || theirs.bound !== fact.bound || theirs.holds?.value !== fact.holds?.value) return false
    }
    return true
  }
  for (let changed = true, rounds = 0; changed && rounds < 64; rounds++) {
    changed = false
    for (const blockId of body.blockOrder) {
      const entry = entryOf(blockId)
      if (entry === null) continue
      const exit = transfer(blockId, entry, false)
      if (sameState(exits.get(blockId), exit)) continue
      exits.set(blockId, exit)
      changed = true
    }
    // A body that has not settled in 64 rounds refines nothing: an unsettled
    // optimistic state is not a sound one.
    if (changed && rounds === 63) return refinements
  }
  for (const blockId of body.blockOrder) {
    const entry = entryOf(blockId)
    if (entry !== null) transfer(blockId, entry, true)
  }
  return refinements
}
