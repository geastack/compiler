// `new NS.Cls(...)` through a namespace import of a class with overloaded
// constructors -- a database client's `new Wire.Long(lo, hi)` in its command builder. The
// namespace's member is the class's constructor object itself, carried by its
// one construct convention, not re-derived from its first overload.
import * as NS from './_overloaded-constructor-module'
import { Wide } from './_overloaded-constructor-module'

const a = new NS.Wide(4, 7)
const b = new NS.Wide('12')
const c = new Wide(5, 1)
console.log(a.low, a.high, b.low, b.high, a instanceof NS.Wide, c.low + c.high)

//! expect: 4 7 12 0 true 6
