// @ts-nocheck
//! expect: a,b 2 x
// pino's `redaction`: a literal with one computed symbol member receives, by
// `reduce`, keys that are strings or symbols. A key the literal's own index
// names lands in that index; any other key is an own property like any other.
const formatSym = Symbol('format')
const extraSym = Symbol('extra')
const shape = { a: null, b: null, [extraSym]: null }
const result = { [formatSym]: 'x' }
const keys = [...Object.keys(shape), ...Object.getOwnPropertySymbols(shape)]
const built = keys.reduce((o, k) => {
  o[k] = typeof k === 'symbol' ? 'sym' : k.toUpperCase()
  return o
}, result)
console.log(Object.keys(built).join(','), Object.getOwnPropertySymbols(built).length, built[formatSym])
