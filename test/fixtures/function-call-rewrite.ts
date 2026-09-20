// `Function.prototype.call` read off a genuinely callable value.
//
// `lib.es5.d.ts`'s `strictBindCallApply` overload types `.call` as
// `call<T, A extends any[], R>(this: (this: T, ...args: A) => R, thisArg: T,
// ...args: A): R` -- a real signature the checker resolves per call site, but
// one this backend has no C++ object anywhere to spell `Function.prototype`
// itself against. `ir/lower-invocation.ts`'s `deferredFunctionCallCalleeOf`
// treats `.call` as sugar instead of a distinct calling convention: `f.call(t,
// a, b)` IS `f`, invoked with `t` as its receiver and `a, b` as its ordinary
// arguments, so the invocation rewrites to call the UNDERLYING receiver's own
// convention directly, and the deferred `[[Get]]` (`emit-properties.ts`) never
// renders anything.
//
// Three shapes that convention has to agree with `.call`'s own generic tuple
// signature about, each exercised below: an ordinary function that never
// reads `this` (the receiver argument is a physical slot in `.call`'s type
// but not in `add`'s, so it is silently discarded, exactly as the language
// does); a method-shaped value whose own convention DOES declare a receiver,
// where the `.call`-supplied this-argument becomes the real one; and a
// variadic underlying callee, where the tail arguments pack against the
// REAL rest parameter rather than the fixed-arity tuple `.call`'s own type
// states for this call site.
function add(a: number, b: number): number {
  return a + b
}
const plain = add.call(null, 3, 4)

class Counter {
  value: number
  constructor(value: number) {
    this.value = value
  }
  addTo(this: Counter, n: number): number {
    return this.value + n
  }
}
const c1 = new Counter(10)
const c2 = new Counter(100)
const methodShaped = c1.addTo.call(c2, 5)

function sumAll(...values: number[]): number {
  let total = 0
  for (const v of values) total += v
  return total
}
const variadicCallee = sumAll.call(null, 1, 2, 3, 4)

const probe = plain + methodShaped + variadicCallee

if (probe !== 7 + 105 + 10) throw new Error('function-call rewrite computed the wrong result')
