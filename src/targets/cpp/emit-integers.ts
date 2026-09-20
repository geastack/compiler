import type { IrValueId } from '../../identity/ids.js'
import type { ComputeOperation, IrOperand } from '../../ir/model.js'
import { cppDenseDivisorName, cppDenseLengthName } from './emit-context.js'

/**
 * Which integer answers the same question a comparison asks of a double.
 *
 * The rounding is the operator's, not the value's -- `i < 5.5` is `i < 6` and
 * `i <= 5.5` is `i <= 5` -- and the sentinel a NaN or an out-of-range bound
 * collapses to differs between the two directions, so the four spellings are
 * four functions rather than one with a flag. `gea_runtime.h` states each one's
 * rule beside it.
 */
const integerBoundHelpers: ReadonlyMap<string, string> = new Map([
  ['<', 'gea::integerBoundLess'],
  ['<=', 'gea::integerBoundLessEqual'],
  ['>', 'gea::integerBoundGreater'],
  ['>=', 'gea::integerBoundGreaterEqual']
])

/** The operator that asks the same question with the operands the other way round. */
const mirroredComparisons: ReadonlyMap<string, string> = new Map([
  ['<', '>'],
  ['<=', '>='],
  ['>', '<'],
  ['>=', '<=']
])

/**
 * A narrowed integer compared against a `number` that stayed a double.
 *
 * `i < iterations` is the loop most programs are built out of, and written as
 * C++ writes it the counter converts to `double` once per iteration for a
 * question that has an exact integer answer. `cvtsi2sd` writes only the low
 * half of its destination, so each conversion carries a false dependency on the
 * last and the loop pays for a chain it never asked for. Restating the BOUND as
 * the integer that answers the same question moves the conversion to a pure
 * function of the bound alone, which leaves the loop by ordinary licm without
 * this emitter proving anything is invariant. Measured on
 * `bench/comparison/fixtures/modulo.ts`: 56.0ms with the conversion in the
 * loop, 37.4ms with the bound restated, against 36.7ms for the hand-written
 * baseline that takes its bound as `long long` to begin with.
 *
 * `null` when this is not that shape -- both sides narrowed (the plain integer
 * compare is already right), neither narrowed, a non-relational operator, or a
 * carrier that is not `number`. Equality is deliberately absent: `i === d` is
 * true only when `d` is exactly `i`, and no rounding of `d` preserves that.
 *
 * Sound because a narrowed value is one the integer census proved holds
 * |i| <= 2^53, far inside the sentinels the helpers clamp to.
 */
export const integerBoundedComparison = (
  integerValues: ReadonlySet<IrValueId>,
  invariant: ReadonlySet<IrValueId>,
  operation: ComputeOperation,
  first: IrOperand,
  second: IrOperand,
  left: string,
  right: string
): string | null => {
  if (first.representation.kind !== 'scalar' || first.representation.domain !== 'number') return null
  const leftNarrowed = integerValues.has(first.value)
  const rightNarrowed = integerValues.has(second.value)
  if (leftNarrowed === rightNarrowed) return null
  // The side that stays a double is the one being restated, so it is the one
  // that has to be free to restate.
  if (!invariant.has(leftNarrowed ? second.value : first.value)) return null
  const asked = leftNarrowed ? operation.operator : mirroredComparisons.get(operation.operator)
  const helper = asked === undefined ? undefined : integerBoundHelpers.get(asked)
  if (helper === undefined) return null
  return leftNarrowed ? `${left} ${operation.operator} ${helper}(${right})` : `${helper}(${left}) ${operation.operator} ${right}`
}

/**
 * The largest dividend text this restates in place rather than handing to
 * `gea::integralRemainder`.
 *
 * The restatement below names the dividend four times, so an unbounded one
 * would compound through nested deferrals. A cap smaller than four times
 * itself is self-limiting: a restatement is already over the cap, so a
 * restatement can never contain another.
 */
const restatableDividend = 80

/**
 * `x % k` for a dividend the census proved integer-valued but too large to
 * narrow, written out where it is used instead of called.
 *
 * The two spellings compute the same thing, and the difference between them is
 * entirely what clang can prove afterwards. Measured on
 * `bench/comparison/fixtures/factorial.ts` (10M iterations, best of five):
 *
 *   gea::remainder (plain fmod)                87.9ms
 *   gea::integralRemainder(expr, k)            83.2ms
 *   a local `double` temp, same guard          83.2ms
 *   restated, `std::abs(expr) < 2^53` guard    62.1ms
 *   restated, `expr > 0 && expr < 2^53`        54.2ms
 *   the hand-written C++ baseline              60.5ms
 *
 * Restating it puts the guard and the division in one expression tree, which
 * is what lets correlated-value-propagation carry the loop-carried range of
 * the dividend into the division: clang then picks the four-instruction
 * UNSIGNED magic-number sequence over the ten-instruction signed one. A local
 * temporary does not do it, and neither does an `abs` guard -- the `> 0.0`
 * half is the non-negativity fact the unsigned form needs. All three were
 * measured, so none of them is worth retrying.
 *
 * Safe to restate because a deferred operand is side-effect free by
 * construction (the deferral census admits only pure kinds), so naming it four
 * times evaluates it once after CSE and cannot reorder anything.
 */
const integralRemainderText = (dividend: string, divisor: string): string => {
  if (dividend.length > restatableDividend) return `gea::integralRemainder(${dividend}, ${divisor})`
  const fast = `static_cast<double>(static_cast<long long>(${dividend}) % ${divisor})`
  const slow = `std::fmod(${dividend}, static_cast<double>(${divisor}))`
  return `((${dividend} > 0.0 && ${dividend} < 9007199254740992.0) ? ${fast} : ${slow})`
}

/**
 * The bitwise family again, for operands the integer census narrowed.
 *
 * `ToInt32` of a double is the expensive half of a JS bitwise operator, and it
 * is pure ceremony over a value already proven to be an integer in a
 * `long long`: keeping the low 32 bits IS `ToInt32` there. Separate names
 * rather than overloads, for the reason `gea::integerRemainder` has one -- a
 * mixed narrowed/unnarrowed call would be ambiguous against the `double` pair,
 * and an ambiguity is a compile error rather than a slow path.
 *
 * Only this family: `+`/`-`/`*` are already infix on both carriers, `/` widens
 * (`7 / 2` is 3.5), and `%` has its own three spellings above.
 */
export const integerBitwiseOperators: ReadonlyMap<string, string> = new Map([
  ['&', 'gea::integerBitwiseAnd'],
  ['|', 'gea::integerBitwiseOr'],
  ['^', 'gea::integerBitwiseXor'],
  ['<<', 'gea::integerLeftShift'],
  ['>>', 'gea::integerSignedRightShift'],
  ['>>>', 'gea::integerUnsignedRightShift']
])

/**
 * The same remainder a moment later, kept in the integers, for the ONE consumer
 * that is allowed to have it: a dense window's own subscript.
 *
 * `x % y` is NaN when `y` is zero, and no `long long` spells NaN -- which is
 * why the census refuses to narrow a remainder whose divisor is not a non-zero
 * constant, and why `ring[i % ring.length]` computes its index as a `double`
 * and converts it back at every use. But a WRAPPED window's flag already says
 * `cells.size() > 0` (`emit-arrays.ts`), so under that flag the divisor cannot
 * be zero and the integer answer is exact. The double form stays for the
 * general arm; this one is emitted beside it and used only inside the guard.
 *
 * Measured on `bench/comparison/fixtures/object_create.ts`, two subscripts of
 * this shape per iteration: 10.8ms converting through a `double`, 7.7ms not --
 * against 6.5ms for a literal `% 256`, so the round trip was three quarters of
 * what a constant length would have been worth.
 */
export const denseRemainderCompanion = (
  ordinal: number,
  dividend: string,
  declarations: { readonly name: string; readonly type: string }[],
  lines: string[]
): { readonly index: string; readonly value: string } => {
  const name = `gea_dense_index_${declarations.length}`
  declarations.push({ name, type: 'long long' })
  lines.push(`${name} = gea::integerRemainderBy(${dividend}, ${cppDenseDivisorName(ordinal)});`)
  // The Number the rest of the body sees is DERIVED from the integer one rather
  // than computed a second time: a conversion where the window has elements,
  // and `NaN` where it has none -- because the divisor here IS that length, so
  // a zero length is `x % 0`, which is NaN for every dividend there is. Naming
  // the general `gea::remainderBy` in that arm instead cost 12% of
  // `object_create`: the arm never runs, but a CALL in the loop body pins the
  // dividend and the receiver live across it, and clang stops sinking either.
  const zero = `${cppDenseLengthName(ordinal)} > 0`
  return { index: name, value: `(${zero} ? static_cast<double>(${name}) : std::numeric_limits<double>::quiet_NaN())` }
}

export const remainderText = (
  form: string | undefined,
  left: string,
  right: string,
  declarations: { readonly name: string; readonly type: string }[],
  hoistedDivisor?: number
): string | null => {
  // A dense window's own length: the preheader already built the reciprocal for
  // it (`emit-arrays.ts`), so there is no memo to re-check and no load to make.
  if (hoistedDivisor !== undefined) return `gea::remainderBy(${left}, ${cppDenseDivisorName(hoistedDivisor)})`
  if (form === 'narrowed') return `gea::integerRemainder(${left}, ${right})`
  if (form === 'restated') return integralRemainderText(left, right)
  // A slot to carry the prepared reciprocal turns the hardware `div` this would
  // otherwise be into a multiply -- see `gea::Divisor`. Without one (a divisor
  // whose value the body cannot name a second time) the plain form still beats
  // `fmod`.
  // The slot is a function-scope local, so the prepared reciprocal survives
  // every iteration of whatever loop the site sits in -- which is the whole
  // point of preparing it. Named from the declaration count and not from the
  // result value: a `%` written straight into a cell renders under the CELL's
  // name, and two such sites in one body would ask for the same slot twice.
  if (form === 'dynamic') {
    const slot = `gea_divisor_${declarations.length}`
    declarations.push({ name: slot, type: 'gea::Divisor' })
    return `gea::remainderBy(${left}, gea::preparedDivisor(${slot}, ${right}))`
  }
  return null
}
