// @ts-nocheck
//! dynamic-fallback
//! expect: 2 true true 0 0 req
// pino's `Object.getOwnPropertySymbols(serializers)`: the symbol half of the
// object's own keys, in the order `Reflect.ownKeys` lists them. A string
// has none (ToObject), and neither does an object keyed only by names.
const first = Symbol('first')
const second = Symbol('second')
const serializers = { req: 1, [first]: 2 }
serializers[second] = 3
const symbols = Object.getOwnPropertySymbols(serializers)
console.log(
  symbols.length,
  symbols[0] === first,
  symbols[1] === second,
  Object.getOwnPropertySymbols('text').length,
  Object.getOwnPropertySymbols({ plain: 1 }).length,
  Object.keys(serializers).join(',')
)
