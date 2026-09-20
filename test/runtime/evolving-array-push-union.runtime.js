// @ts-nocheck
// The evolving element WIDENS across pushes. The write-set census must answer
// the disagreement as the same `string | number | boolean` the checker's own
// evolving-array widening settles the array to, so storage, every settled
// read, and every `push` slot are one carrier -- never the box.
var xs = []
xs.push(1)
xs.push('a')
xs.push(true)
console.log(xs.join(','), xs.length)
//! expect: 1,a,true 3
// The last reference SETTLES here (`join` is not an evolving-array operation
// target, `length` above is), so the declaration's storage comes from the
// checker and the push slots from the census: the two must agree exactly.
var ws = []
ws.push(2)
ws.push('b')
console.log(ws.join('|'))
//! expect: 2|b
function f() {
  var ys = []
  ys.push({ k: 1 })
  ys.push({ k: 2 })
  return ys.map((y) => y.k).join('+')
}
console.log(f())
//! expect: 1+2
//! emitted-lacks: gea::Value::box
//! emitted-lacks: unboxValue
