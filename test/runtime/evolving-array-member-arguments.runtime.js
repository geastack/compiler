// @ts-nocheck
//! expect: a,b,c 3 1 false 0
//! expect: 1+2 true
//! emitted-lacks: gea::Value
// `var xs = []` is an evolving array: the checker types `xs.push` at the read
// as `(...items: any[]) => number` (or `never[]`), while the census already
// chose `ArrayObject<std::string>` for the storage. The member's own signature
// and the call's resolved signature both carry the census's element now, so
// no argument is boxed on its way into native storage.
var xs = []
xs.push('a')
xs.push('b', 'c')
console.log(xs.join(','), xs.length, xs.indexOf('b'), xs.includes('z'), xs.lastIndexOf('a'))
var ys = []
function add(v) {
  ys.push(v)
}
add(1)
add(2)
console.log(ys.join('+'), ys.includes(2))
