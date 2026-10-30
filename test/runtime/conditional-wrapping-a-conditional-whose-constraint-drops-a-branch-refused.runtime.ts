//! expect-refusal: an anonymous conditional type is still gated on a type parameter
// `Outer`'s branch WRAPS a conditional the checker misdescribes (see
// `conditional-whose-checker-constraint-drops-a-branch-refused`). The checker's
// bound of `Outer<T['shape']>` is `{ v: string }`, and it relates the branch
// `{ v: Overlap<S> }` to that bound through `Overlap`'s own constraint,
// `string`, so the branch looks as if it fits. The copy for `Both` holds `{ v:
// 41 }`. Laid out as `{ v: string }`, a value that reaches the copy through
// `any` is stored without a conversion and read back as the wrong type. A
// branch with a type parameter inside it proves nothing about the bound, so
// the conditional stays refused.
function ensure<T>(value: T | null | undefined, message: () => string): asserts value is T {
  if (value == null) throw new Error(message())
}

type Overlap<S> = S extends { b: number } ? number : string
type Outer<S> = S extends { a: string } ? { v: Overlap<S> } : never
interface Shaped {
  shape: { a: string }
}
interface Both extends Shaped {
  shape: { a: string; b: number }
}
function describe<T extends Shaped>(raw: any): string {
  const holder: { value?: Outer<T['shape']> | undefined } = { value: raw }
  ensure(holder.value, () => 'no value')
  return `${typeof holder.value.v} ${JSON.stringify(holder.value)}`
}
console.log(describe<Both>({ v: 41 }), describe<Shaped>({ v: 'x' }))
export {}
