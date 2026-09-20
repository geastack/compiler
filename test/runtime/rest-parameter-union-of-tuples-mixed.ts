//! expect: 1;
//! expect: 2;x;
//! expect: n 3
//! expect: s hi
// A rest parameter annotated as a union of tuples whose arms state UNRELATED
// types -- `[a: number] | [a: number, b: string]`, hono's
// `defineWebSocketHelper` shape one step smaller. `[] | [TNext]`'s widening
// has nothing to pick here, and the answer is not to leave the union alone:
// the array holds one argument per slot, so its element is the union of what
// the arms state at every position. The ABI slot and the body's own binding
// both derive that from `restParameterUnionOfTuplesElementTypeOf`, and before
// they did the ABI published `Array<[a] | [a, b]>` while the binding kept the
// union itself -- 'parameter 0 is bound as "tagged-union(...)" but the ABI
// declares "array-object(...)"'.
const join = (...args: [a: number] | [a: number, b: string]): string => {
  let out = ''
  for (const v of args) out += String(v) + ';'
  return out
}
console.log(join(1))
console.log(join(2, 'x'))

const report = (...args: [n: number] | [s: string]): string => {
  const first = args[0]
  return typeof first === 'string' ? 's ' + first : 'n ' + String(first)
}
console.log(report(3))
console.log(report('hi'))
