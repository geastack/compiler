// @ts-nocheck
//
// A parameter nobody typed takes the join of what its call sites pass. When
// one site passes an object literal and another a class instance (or a wider
// literal), the literal's record covers both, and the join used to answer
// it. The other argument then reached the callee through a record VIEW
// (`emit-record-view.ts`), which is a copy: the callee's writes landed on the
// copy and the caller's object never saw them (plan item 1.15). A join the
// compiler infers must not pick a carrier that copies one of its own
// observations; the parameter keeps one storage for every caller instead.
//
// That parameter is then dynamic, and a literal the program never writes
// through its own type was still carried BY VALUE (`value-records.ts`), so
// boxing it into the dynamic slot copied it too. A record passed to an
// `any` parameter is not a value record.
class Descriptor {
  constructor() {
    this.label = 'tex'
    this.sampleCount = 1
  }
}
function mark(d) {
  d.label += '!'
  d.sampleCount = d.sampleCount * 4
  return d.label + ':' + d.sampleCount
}
const literal = { label: 'lit', sampleCount: 2 }
console.log(mark(literal), literal.label, literal.sampleCount)
const desc = new Descriptor()
console.log(mark(desc), desc.label, desc.sampleCount)

const seen = new WeakSet()
function touch(options) {
  options.label += '?'
  seen.add(options)
  return options.label
}
const small = { label: 'small', size: 1 }
const wide = { label: 'wide', size: 2, format: 'rgba8' }
console.log(touch(small), small.label, seen.has(small))
console.log(touch(wide), wide.label, wide.format, seen.has(wide))

function bump(x) {
  x.count = x.count + 1
}
const counter = { count: 1 }
bump(counter)
bump(JSON.parse('{"count":5}'))
console.log(counter.count)

// A descriptor and its `Object.assign` copy into one untyped function.
function stamp(d) {
  d.label += '#'
  return d.label
}
const original = new Descriptor()
const copy = Object.assign({}, original)
copy.sampleCount = 4
console.log(stamp(original), stamp(copy), original.label, copy.label, copy.sampleCount)
//! expect: lit!:8 lit! 8
//! expect: tex!:4 tex! 4
//! expect: small? small? true
//! expect: wide? wide? rgba8 true
//! expect: 2
//! expect: tex# tex# tex# tex# 4
