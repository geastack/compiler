// @ts-nocheck
var tag = Function.prototype.call.bind(Object.prototype.toString)
console.log(
  tag([1, 2]),
  tag(function example() {}),
  tag(null),
  tag()
)
//! expect: [object Array] [object Function] [object Null] [object Undefined]
console.log(
  Object.prototype.toString.call(Math),
  Object.prototype.toString.call(42),
  Object.prototype.toString.call(true),
  Object.prototype.toString.call('hello')
)
//! expect: [object Math] [object Number] [object Boolean] [object String]
var evaluations = 0
function receiver() {
  evaluations = evaluations * 10 + 1
  return [7]
}
function ignored() {
  evaluations = evaluations * 10 + 2
}
console.log(Object.prototype.toString.call(receiver(), ignored()), evaluations)
//! expect: [object Array] 12
var record = {
  toString() {
    evaluations += 100
    return 'wrong'
  }
}
console.log(tag(record), evaluations, [1, 2].toString())
//! expect: [object Object] 12 1,2
console.log(Object.prototype.toString.call(ignored()), evaluations)
//! expect: [object Undefined] 122
console.log(tag(new Date(0)), tag(/x/), tag(new Error('x')))
//! expect: [object Date] [object RegExp] [object Error]
//! emitted-has: gea::objectTag(
//! emitted-lacks: gea::Value::box
