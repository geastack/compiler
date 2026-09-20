// @ts-nocheck
// An EMPTY array literal with no annotation: TypeScript types the binding as an
// "evolving array" whose element is known only from later `push` calls. The
// binding's own storage census already narrows it to `string`; the push call's
// rest-parameter packing must agree, never box each argument to unbox it again.
var xs = []
xs.push('a')
xs.push('b')
console.log(xs.join('; '))
//! expect: a; b
function inner() {
  let ys = []
  ys.push(1, 2)
  ys.unshift(0)
  return ys.join(',')
}
console.log(inner())
//! expect: 0,1,2
const zs = []
for (let i = 0; i < 3; i++) zs.push('z' + i)
console.log(zs.length, zs.join('|'))
//! expect: 3 z0|z1|z2
//! emitted-lacks: gea::Value::box
//! emitted-lacks: unboxValue
