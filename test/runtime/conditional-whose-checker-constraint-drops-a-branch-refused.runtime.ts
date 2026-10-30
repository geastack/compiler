//! expect-refusal: an anonymous conditional type is still gated on a type parameter
// The same assertion as `generic-assertion-over-a-conditional-of-the-enclosing-copy`,
// over a conditional the checker misdescribes. Its base constraint of
// `Overlap<T['shape']>` is `string`: it drops the true branch because `{ b:
// number }` and `{ a: string }` overlap without either being assignable to the
// other. The copy for `Both` takes that branch and holds a number. Laid out as
// `string` the value has no arm in its slot (an abort); laid out as `number |
// string` the checker still narrows `typeof value === 'number'` to `never`
// (`NaN`). No carrier agrees with both, so the conditional stays refused.
function ensure<T>(value: T | null | undefined, message: () => string): asserts value is T {
  if (value == null) throw new Error(message())
}

type Overlap<S> = S extends { b: number } ? number : string
interface Shaped {
  shape: { a: string }
}
interface Both extends Shaped {
  shape: { a: string; b: number }
}
function describe<T extends Shaped>(holder: { value?: Overlap<T['shape']> | undefined }): string {
  ensure(holder.value, () => 'no value')
  const value = holder.value
  return typeof value === 'number' ? `number ${value + 1}` : `string ${value}`
}
console.log(describe<Both>({ value: 41 }), describe<Shaped>({ value: 'x' }))
export {}
