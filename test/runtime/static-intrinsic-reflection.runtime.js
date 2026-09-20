// @ts-nocheck
// test262's built-ins/Math/SQRT2/prop-desc.js pattern: verifyProperty reads a
// property descriptor back off a host intrinsic and checks its attributes.
// This program drives the same shape across Math (a namespace-shaped
// native-handle) and Array.prototype (a native array with intrinsic own
// properties held in its identity sidecar). A builtin FUNCTION as the receiver
// (`verifyProperty(Array.from, 'name', ...)`) is a separate family, not yet
// answered natively.
//
// One reflection helper per RECEIVER KIND, deliberately. A single `describe`
// called with Math, Array.prototype and Array.from would bind its parameter
// to the join of all three -- native-handle | array-object | dynamic -- and
// that join is a separate, still-open question in the parameter census
// (`semantics/normalize/parameter-bindings.ts`'s `unionArmsAt`: a
// `dynamic(unjoinable-declared-overload-set)` arm has no installed conversion
// into the concrete carrier the other sites settled on). This program pins
// the reflection answers, so each helper sees exactly one receiver kind.
function describe(obj, name) {
  var d = Object.getOwnPropertyDescriptor(obj, name)
  return d === undefined ? 'absent' : [typeof d.value, d.writable, d.enumerable, d.configurable].join('/')
}
function describeArray(obj, name) {
  var d = Object.getOwnPropertyDescriptor(obj, name)
  return d === undefined ? 'absent' : [typeof d.value, d.writable, d.enumerable, d.configurable].join('/')
}
console.log(typeof Math, describe(Math, 'SQRT2'), describe(Math, 'pow'), describe(Math, 'nope'))
//! expect: object number/false/false/false function/true/false/true absent
// The module body this compiler emits is strict throughout (there is no
// sloppy top level the way a plain script has one), so `delete` of
// `Math.SQRT2` -- non-configurable per 21.3.1.1 -- THROWS rather than
// returning `false`. Real Node run as an ES module confirms it: `TypeError:
// Cannot delete property 'SQRT2' of #<Object>`, uncaught, before this
// statement's own `console.log` ever runs. `rejects` observes that outcome
// instead of the call's return value, exactly like
// `static-property-descriptors.runtime.js`'s helper of the same name.
function rejects(action) {
  try {
    action()
    return 'missing'
  } catch (error) {
    return error instanceof Error ? error.name : 'unexpected'
  }
}
console.log(
  Object.prototype.hasOwnProperty.call(Math, 'SQRT2'),
  rejects(function () {
    delete Math.SQRT2
  }),
  Math.SQRT2 === Math.SQRT2
)
//! expect: true TypeError true
var keys = []
for (var k in Math) keys.push(k)
console.log(keys.length, Object.prototype.propertyIsEnumerable.call(Math, 'SQRT2'))
//! expect: 0 false
console.log(typeof Array.prototype, typeof Array.prototype.join, describeArray(Array.prototype, 'join'))
//! expect: object function function/true/false/true
console.log(
  Object.prototype.toString.call([]),
  Object.prototype.toString.call(Math),
  Object.prototype.toString.call(null),
  Object.prototype.toString.call(function () {})
)
// Borrowing Object.prototype.toString preserves its tag algorithm even when
// the receiver has its own toString implementation.
//! expect: [object Array] [object Math] [object Null] [object Function]
var m = Math
console.log(m.max(1, 2), m === Math, Object.getOwnPropertyNames(Math).indexOf('SQRT2') >= 0)
//! expect: 2 true true
