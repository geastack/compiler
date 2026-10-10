// A member read off a module namespace that is itself reached through an
// import binding: `import { Wire } from 'wire-format'` (whose index does
// `import * as Wire from './wire'; export { Wire }`) followed by
// `Wire.serialize(...)`, and `dns.promises.lookup(...)` where `promises` is a
// namespace re-exported by `node:dns`. Both name the member's own binding --
// the namespace object is a path, and no cell holds it.
import { inner } from './_namespace-reexport-outer'
import * as outer from './_namespace-reexport-outer'

console.log(inner.serialize(1), inner.onDemand.twice(3), inner.TIMEOUT)
console.log(outer.inner.serialize(4), outer.inner.onDemand.twice(5), outer.inner.TIMEOUT === 'ETIMEOUT')
const f = outer.inner.serialize
console.log(f(10))

//! expect: 2 6 ETIMEOUT
//! expect: 5 10 true
//! expect: 11
