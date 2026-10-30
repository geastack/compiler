//! expect-refusal: an anonymous conditional type is still gated on a type parameter
// The class has ONE copy, `Holder<Both>`, and it closes the check type
// `S['shape']` to `{ a: string; b: number }`, which selects the true branch:
// `r` holds 41. The checker reasons about `r` inside the template through its
// base constraint, which is `string`: at `S extends Shaped` the distributive
// constraint drops the true branch (`{ a: string }` and `{ b: number }`
// overlap without either being assignable to the other). So it narrows
// `typeof r === 'number'` to `never`, and the read of `r` in that branch was
// laid out as `undefined`: the copy printed `number NaN`, Node prints
// `number 42`. Every copy agreeing on a branch is not enough; the branch must
// also be one the checker's own constraint admits, or the conditional keeps
// its refusal. The two-copy form is
// `conditional-whose-checker-constraint-drops-a-branch-refused`.
const settle = <T>(v: T): T extends { b: number } ? number : string => {
  const out: any = typeof (v as any).b === 'number' ? (v as any).b : 'none'
  return out
}
interface Shaped {
  shape: { a: string }
}
interface Both extends Shaped {
  shape: { a: string; b: number }
}
class Holder<S extends Shaped> {
  readonly value: S['shape']
  constructor(value: S['shape']) {
    this.value = value
  }
  describe(): string {
    const r = settle(this.value)
    return typeof r === 'number' ? `number ${r + 1}` : `string ${r}`
  }
}
console.log(new Holder<Both>({ a: 'x', b: 41 }).describe())
export {}
