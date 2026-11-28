import { representationKey, type Representation } from '../representation/model.js'

/**
 * What one `Array.prototype.flatMap` call (ECMA-262 23.1.3.14) stores into
 * its result, read off the callback's stored result carrier and the call's
 * published result carrier.
 *
 * FlattenIntoArray at depth 1 spreads an Array the callback returns and
 * appends any other value as one element. Which arm a callback result is can
 * be a compile-time fact (one carrier) or a runtime one (a `TaggedUnion`), but
 * either way every value that reaches the result is one of `flattened`: an
 * array arm's element carrier, or a non-array arm itself. The checker's empty
 * `never[]` (`f(x) ?? []`, carried `array-object(undefined)`) contributes no
 * value when the result's element cannot hold `undefined`: it is empty by its
 * type.
 *
 * The runtime template stores those values in one of two ways, and this is
 * the one authority on which applies:
 *
 * - `stated`: the emitter names the result carrier (`flatMap<Result>`) and
 *   `flatMapAppend` stores each value as-is -- the result's own element, one
 *   of its union arms by injection, or an optional's payload. Needed when the
 *   callback returns a union (`T | T[]`) or the result is a recursive wrapper.
 * - `deduced`: the result is `ArrayObject<X>` for the callback's own `X` (an
 *   array result's element, or the value itself), right exactly when that IS
 *   the published element.
 *
 * When neither holds -- `entries.flatMap<Route>((e) => e.ok ? [{ a }] :
 * e.reads.map((r) => ({ a, b: r })))`, whose two arms are arrays of two
 * different fresh records, neither of them `Route` -- every flattened value
 * that is not already the element enters it through the call's own certified
 * `prototype-result` conversion (`converted`), registered by
 * `host-template-conversions.ts` and rendered by `emit-prototype-array.ts`.
 */
export interface FlatMapFlattening {
  /** Every distinct value carrier the callback's result contributes, in arm order. */
  readonly flattened: readonly Representation[]
  /** `flatMapAppend` stores every flattened value as-is into the stated result carrier. */
  readonly stated: boolean
  /** The runtime's deduced `ArrayObject<X>` is already the published result. */
  readonly deduced: boolean
  /** The flattened carriers that need a conversion into the element; empty when `stated || deduced`. */
  readonly converted: readonly Representation[]
}

export const flatMapFlatteningOf = (produced: Representation, held: Representation): FlatMapFlattening | null => {
  if (held.kind !== 'array-object' || held.ownership !== 'shared-refcount' || produced.kind === 'void') return null
  const element = held.element
  const elementText = representationKey(element)
  const stores = (value: Representation): boolean => {
    const key = representationKey(value)
    if (key === elementText) return true
    if (element.kind === 'tagged-union') return element.arms.some((arm) => representationKey(arm.value) === key)
    return element.kind === 'optional' && representationKey(element.payload) === key
  }
  const emptyByType = (value: Representation): boolean =>
    value.kind === 'array-object' && value.element.kind === 'undefined' && !stores(value.element)
  const arms = produced.kind === 'tagged-union' ? produced.arms.map((arm) => arm.value) : [produced]
  const stated =
    (produced.kind === 'tagged-union' || held.recursive !== undefined) &&
    arms.every((value) => (value.kind === 'array-object' ? stores(value.element) || value.element.kind === 'undefined' : stores(value)))
  const flattened = new Map<string, Representation>()
  for (const value of arms) {
    if (emptyByType(value)) continue
    const contributed = value.kind === 'array-object' ? value.element : value
    flattened.set(representationKey(contributed), contributed)
  }
  const deduced =
    produced.kind !== 'tagged-union' &&
    held.recursive === undefined &&
    representationKey(produced.kind === 'array-object' ? produced.element : produced) === elementText
  const converted = stated || deduced ? [] : [...flattened.values()].filter((value) => representationKey(value) !== elementText)
  return { flattened: [...flattened.values()], stated, deduced, converted }
}
