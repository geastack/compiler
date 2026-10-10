// `g.call(value)` on a NATIVELY carried callable stays a direct call of `g`
// even though the program writes computed keys through a boxed target
// somewhere (`stamp` below) -- the one write shape that could, in principle,
// give some Function object an own `call`. Whether it reached THIS object is
// a run-time fact about one object, read off its own-property table before
// the call (`CallOperation.builtinShadowGuard`), not a whole-program reason
// to route every unknown-origin `.call` through `.call`'s own generic frame
// with a heap adapter per invocation. A binary-document serializer's parser
// utilities are exactly this shape inside a database client, where the client's own `any`-typed
// option writes put the computed-key wildcard into the facts.
//! emitted-lacks: adaptSource
//! emitted-has: callableBuiltinIsIntrinsic
const g = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
const tagOf = (value: unknown) => g.call(value)

const stamp = (target: any, key: string, value: unknown): void => {
  target[key] = value
}
const bag: Record<string, unknown> = {}
stamp(bag, 'x', 1)
console.log(tagOf(new Uint8Array(2)), tagOf(new Float64Array(1)), tagOf(3), Object.keys(bag).length)
//! expect: Uint8Array Float64Array undefined 1

function sum(this: unknown, a: number, b: number): number {
  return a + b
}
console.log(sum.call(null, 1, 2))
//! expect: 3

// The guard's other answer: the SAME write shape, this time reaching a
// Function object the program boxed. The builtin is shadowed on that one
// object, and the direct frame is the callee's, not the program's `call`, so
// the call refuses by name instead of silently running the builtin.
function label(this: { name: string }): string {
  return this.name
}
const boxed: any = label
stamp(boxed, 'call', () => 'shadowed')
try {
  console.log(label.call({ name: 'n' }))
} catch {
  console.log('refused')
}
//! expect: refused
export {}
