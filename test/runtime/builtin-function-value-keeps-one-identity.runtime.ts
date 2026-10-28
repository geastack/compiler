// A builtin function read as a value is one function object, however many
// sites read it and whatever carrier holds it. Zag's `isPlainObject` keeps
// `Function.prototype.toString` in a module constant; a prototype method read
// as a value is rendered the same way.
//! expect: true true true true
const toStringA = Function.prototype.toString
const toStringB = Function.prototype.toString
const boxedA: any = Function.prototype.toString
const boxedB: unknown = Function.prototype.toString
const getTimeA: any = Date.prototype.getTime
const getTimeB: any = Date.prototype.getTime
console.log(toStringA === toStringB, boxedA === boxedB, getTimeA === getTimeB, boxedA !== getTimeA)
