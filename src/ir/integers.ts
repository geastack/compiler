import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { controlFlowGraphOf, dominatorTreeOf, naturalLoopsOf } from './dominance.js'
import type { Representation } from '../representation/model.js'
import type { ComputeOperation, IrBlockId, IrBody, IrOperand } from './model.js'
import { numericIntrinsicsOf } from './numeric-intrinsics.js'

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
}

export const emptyIntegerNarrowing: IntegerNarrowing = {
  values: new Set(),
  bindings: new Set(),
  magnitudes: new Map(),
  integral: new Set(),
  integralRemainders: new Set(),
  dynamicRemainders: new Set()
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

export type IntegerMagnitude =
  { readonly kind: 'bounded'; readonly limit: number } | { readonly kind: 'linear'; readonly coefficient: number }
type Magnitude = IntegerMagnitude

const boundedBy = (limit: number): Magnitude | null =>
  Number.isFinite(limit) && limit <= exactIntegerLimit ? { kind: 'bounded', limit } : null

const growsBy = (coefficient: number): Magnitude | null =>
  Number.isFinite(coefficient) && coefficient <= linearCoefficientCap ? { kind: 'linear', coefficient } : null

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
  return growsBy(coefficient)
}

/** The name every reader inside this file uses for the join above. */
const widen = widenIntegerMagnitude

const sum = (left: Magnitude, right: Magnitude): Magnitude | null => {
  if (left.kind === 'bounded' && right.kind === 'bounded') return boundedBy(left.limit + right.limit)
  return growsBy((left.kind === 'linear' ? left.coefficient : 0) + (right.kind === 'linear' ? right.coefficient : 0))
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

/** The operators whose result is an integer whatever reached them (ECMA-262 6.1.6.1.2, .9-.11, .16-.19). */
const bitwiseOperators: ReadonlySet<string> = new Set(['&', '|', '^', '<<', '>>', '>>>', '~'])

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
  for (const [call, intrinsic] of numericIntrinsicsOf(body).calls) {
    if (intrinsic === 'imul' && call.result) imulResults.add(call.result.id)
  }
  const definitions = new Map<IrValueId, { readonly kind: string; readonly operation: unknown }>()
  const computes = new Map<IrValueId, ComputeOperation>()
  const lengthReads = new Set<IrValueId>()
  const constantTexts = new Map<IrValueId, string>()
  const constants = new Map<IrValueId, number>()
  const readsCell = new Map<IrValueId, DeclarationId>()
  const cellWrites = new Map<DeclarationId, { readonly value: IrOperand; readonly block: IrBlockId }[]>()
  const cellScalar = new Map<DeclarationId, boolean>()
  const phis = new Map<IrValueId, readonly IrOperand[]>()
  const valueRepresentations = new Map<IrValueId, Representation>()

  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
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
    const literal = only === undefined ? undefined : constants.get(only.value.value)
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

  const producesInteger = (value: IrValueId): boolean => {
    if (imulResults.has(value)) return true
    if (constants.has(value)) return true
    if (lengthReads.has(value)) return true
    // A read of storage a whole-program census settled. Asked before the
    // definition kinds below because the operation that produced it is a `get`,
    // which none of them models -- without this it falls through to `return
    // false` and every field of every record is a double.
    const slot = storage.reads.get(value)
    if (slot !== undefined) return storage.integral.has(slot)
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
    if (compute.form === 'update') {
      const target = compute.operands[0]
      return target && readsCell.get(target.value) === cell ? { kind: 'bounded', limit: 1 } : null
    }
    if (compute.form !== 'binary' || (compute.operator !== '+' && compute.operator !== '-')) return null
    const [left, right] = compute.operands
    if (!left || !right) return null
    const self = readsCell.get(left.value) === cell ? right : readsCell.get(right.value) === cell ? left : null
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
    let seeds: Magnitude | null = written.length > 0 ? { kind: 'bounded', limit: 0 } : null
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
    if (imulResults.has(operand.value)) return boundedBy(2 ** 31)
    const constant = constants.get(operand.value)
    if (constant !== undefined) return boundedBy(Math.abs(constant))
    if (lengthReads.has(operand.value)) return boundedBy(bitwiseWidth)
    const slot = storage.reads.get(operand.value)
    if (slot !== undefined) return storage.magnitudes.get(slot) ?? null
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
      if (compute.operator === '~') return boundedBy(bitwiseWidth)
      if (compute.operator !== '-' && compute.operator !== '+') return null
      return magnitudeOfValue(left)
    }
    if (compute.form !== 'binary' || !right) return null
    switch (compute.operator) {
      case '&': {
        // A mask by a non-negative constant bounds the result at the mask; any
        // other AND is still a 32-bit quantity.
        const mask = constants.get(right.value) ?? constants.get(left.value)
        return mask !== undefined && mask >= 0 ? boundedBy(mask) : boundedBy(bitwiseWidth)
      }
      case '|':
      case '^':
      case '<<':
      case '>>':
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

  const values = new Set<IrValueId>()
  const bindings = new Set<DeclarationId>()
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
  return { values, bindings, magnitudes, integral, integralRemainders, dynamicRemainders }
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
