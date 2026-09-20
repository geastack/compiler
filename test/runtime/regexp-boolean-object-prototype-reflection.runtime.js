// @ts-nocheck
// `RegExp.prototype`/`Boolean.prototype`/`Object.prototype` read as VALUES,
// widened from the Date-only "prototype-object protocol"
// (`native-protocols.ts`'s `RegExp.prototype@1`/`Boolean.prototype@1`/
// `Object.prototype@1`, `host-members.ts`'s `RegExpConstructor.prototype`/
// `BooleanConstructor.prototype`/`ObjectConstructor.prototype`): each is a
// namespace-shaped intrinsic whose own members are the instance methods,
// reflected exactly as `Date.prototype` already is. Stands for test262's
// `built-ins/RegExp/prototype/*/{name,length,prop-desc}.js`,
// `built-ins/Boolean/prototype/*/{name,length,prop-desc}.js` and
// `built-ins/Object/prototype/*/{name,length,prop-desc}.js` families -- picked
// over `hasOwnProperty`/`propertyIsEnumerable` because those two names are
// ALSO claimed by the unrelated `objectShapePrototypeMethods` deferred-call
// mechanism (`object-protocol.ts`), which fuses them with an immediate call
// and refuses the identical bare-value read this file exercises; that
// conflict predates this change (it is a name-only gate, not specific to
// these three protocols) and is out of scope here.
//! expect: exec false false true 1
//! expect: valueOf false false true 0
//! expect: toString false false true 0
//! expect: true true true
//! expect: true true true
var re = Object.getOwnPropertyDescriptor(RegExp.prototype.exec, 'name')
console.log(re.value, re.writable, re.enumerable, re.configurable, RegExp.prototype.exec.length)
var bo = Object.getOwnPropertyDescriptor(Boolean.prototype.valueOf, 'name')
console.log(bo.value, bo.writable, bo.enumerable, bo.configurable, Boolean.prototype.valueOf.length)
var ob = Object.getOwnPropertyDescriptor(Object.prototype.toString, 'name')
console.log(ob.value, ob.writable, ob.enumerable, ob.configurable, Object.prototype.toString.length)
console.log(
  Object.prototype.hasOwnProperty.call(RegExp.prototype, 'exec'),
  Object.prototype.hasOwnProperty.call(Boolean.prototype, 'valueOf'),
  Object.prototype.hasOwnProperty.call(Object.prototype, 'toString')
)
console.log(
  Object.prototype.hasOwnProperty.call(RegExp.prototype, 'nope') === false,
  Object.prototype.hasOwnProperty.call(Boolean.prototype, 'nope') === false,
  Object.prototype.hasOwnProperty.call(Object.prototype, 'nope') === false
)
