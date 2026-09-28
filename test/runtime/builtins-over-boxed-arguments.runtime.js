// @ts-nocheck
//! dynamic-fallback
//! expect: a-b-c AB x.y
//! expect: 2020-01-02T00:00:00.000Z true
//! expect: 3 1 2,4,6
//! expect: skipped called TypeError
// Arguments whose kind is a run-time fact of their box: a separator or search
// that may be a RegExp, a replacement that may be a function, a Date source
// that may be a Date, and iterables of unknown kind.
const box = JSON.parse('{"comma":",","dot":"1","when":"2020-01-02T00:00:00Z","items":[1,2,3],"pair":[["x",1]]}')
box.re = /[a-z]/g
box.d = new Date(0)
console.log('a,b,c'.split(box.comma).join('-'), 'ab'.replace(box.re, function (m) { return m.toUpperCase() }), 'x1y'.replace(box.dot, '.'))
console.log(new Date(box.when).toISOString(), new Date(box.d).getTime() === 0)
console.log(new Set(box.items).size, new Map(box.pair).get('x'), Array.from(box.items, function (v) { return v * 2 }).join(','))
function Controller (skip) { this.skip = skip; this.isFunction = typeof skip === 'function' }
Controller.prototype.skipped = function (req) { return this.isFunction ? this.skip(req) : this.skip }
const flag = new Controller(true)
const fn = new Controller(function () { return 'called' })
let threw = 'no'
try { new Controller(1).skip() } catch (e) { threw = e.name }
console.log(flag.skipped() ? 'skipped' : 'kept', fn.skipped(), threw)
