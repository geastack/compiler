// A generic whose parameter is mentioned ONLY inside `T | undefined` --
// tsc's `toSearchResult` shape, and the smallest one. The specialization
// census strips the optionality marker from both sides before pairing the
// hole with its filling, and it did so through `getNonNullableType`; for an
// UNCONSTRAINED `T` that spells `NonNullable<T>` as `T & {}`, an intersection,
// which the hole test does not recognise. So `T` bound nothing, no copy was
// minted, and every direct call was refused at lowering as "a call through a
// generic function set has no closed family of instantiated copies". A
// `fallback: T` beside it (or a constrained `T`) hid the defect completely.
interface Resolved {
  path: string
}
function maybe<T>(value: T | undefined): T | undefined {
  return value !== undefined ? value : undefined
}
function orNull<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value
}
const some: number | undefined = 3
// Spelled with its argument: a `const` initialised to `undefined` is NARROWED to
// `undefined` at the call, and `maybe(none)` then infers `T` as `unknown` -- a
// filling nothing in the program states, so no copy is minted for it.
const none: number | undefined = undefined
console.log(maybe(some), maybe<number>(none) === undefined ? 'none' : 'some', maybe<number>(undefined) === undefined ? 'none' : 'some')
const resolved = maybe<Resolved>({ path: 'src/a.ts' })
console.log(resolved === undefined ? 'none' : resolved.path, maybe<Resolved>(undefined) === undefined ? 'none' : 'some')
console.log(orNull<string>('x'), orNull<string>(undefined), orNull<string>(null))
//! expect: 3 none none
//! expect: src/a.ts none
//! expect: x null null
