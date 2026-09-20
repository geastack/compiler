//! expect: 5 3 2 7 nope
// A type parameter the checker narrows to an intersection with a UNION
// member -- `T & ({} | null)` for `value !== undefined`, or a written
// `T & {}` -- and a copy that binds `T` to a union. TypeScript distributes
// an intersection over a union when it BUILDS one, so the substituted copy
// must do the same: `(Item | null) & ({} | null)` is `Item | null`, and
// `(number | undefined) & {}` is `number`. tsc's `assertIsDefined<T>` and
// `cast<TOut extends TIn, TIn>` shape.
interface Item {
  id: number
}
function orElse<T>(value: T | undefined, fallback: T): T {
  if (value !== undefined) return value
  return fallback
}
function nonNull<T>(value: T, label: string): T & {} {
  if (value === undefined || value === null) throw new Error(label)
  return value
}
function maybe(flag: boolean): number | undefined {
  return flag ? 5 : undefined
}
function maybeItem(flag: boolean): Item | null {
  return flag ? { id: 2 } : null
}
let caught = 'none'
try {
  nonNull(maybeItem(false), 'nope')
} catch (error) {
  caught = error instanceof Error ? error.message : 'other'
}
console.log(
  orElse(maybe(true), 3),
  orElse(maybe(false), 3),
  orElse<Item | null>(maybeItem(true), null)?.id,
  nonNull(maybe(true), 'n') + 2,
  caught
)
