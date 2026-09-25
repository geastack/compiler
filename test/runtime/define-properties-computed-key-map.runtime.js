//! dynamic-fallback
//! expect: c 0 5 x,ctx false false true TypeError none
// fastify's Reply: `Object.defineProperties(Proto.prototype, map)` over a map
// with a computed symbol key, which the closed-literal rewrite leaves alone.
// The map crosses whole into ObjectDefineProperties: accessors default to
// non-enumerable and non-configurable, and a map with one invalid descriptor
// defines none of them.
'use strict'
const kCtx = Symbol('ctx')
const kStart = Symbol('start')
function R (x, ctx) { this.x = x; this.ctx = ctx; this[kStart] = undefined }
Object.defineProperties(R.prototype, {
  [kCtx]: {
    get () { return this.ctx }
  },
  elapsed: {
    get () {
      if (this[kStart] === undefined) return 0
      return this[kStart]
    }
  },
  v: {
    enumerable: true,
    get () { return this.x },
    set (value) { this.x = value }
  }
})
const r = new R(3, 'c')
r.v = 5
const elapsed = Object.getOwnPropertyDescriptor(R.prototype, 'elapsed')
const v = Object.getOwnPropertyDescriptor(R.prototype, 'v')
let failure = 'none'
function Q () {}
const target = Q.prototype
try {
  Object.defineProperties(target, { [kCtx]: { value: 1 }, bad: { value: 1, get () { return 2 } } })
} catch (error) {
  failure = error.name
}
console.log(r[kCtx], r.elapsed, r.v, Object.keys(r).join(','), elapsed.enumerable, elapsed.configurable, v.enumerable, failure, target[kCtx] === undefined ? 'none' : 'some')
