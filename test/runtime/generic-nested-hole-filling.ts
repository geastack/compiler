//! expect: counts=531
//! emitted-lacks: gea::Value

// A generic body instantiating another generic with the hole NESTED inside
// the filling: `count(items)` inside `outer<T>` fills `U` with `T[]`, never a
// bare `T`. The public checker API cannot build `string[]` on request, but the
// checker already built it for the call that minted `outer`'s copy -- the
// resolved signature pairs `T[]` with `string[]` -- and the copy answers the
// nested site from that pairing (`Specialization.fillingOf`). Before it did,
// `count` had no copy for `string[]`, the callee read named the root
// declaration, and emission refused the whole of `outer`.
function count<U>(item: U): number {
  return Array.isArray(item) ? item.length : 1
}
function outer<T>(items: T[]): number {
  return count(items) + count(items.slice(1))
}
const words = ['x', 'y', 'z']
const pairs = [
  [1, 2],
  [3, 4]
]
console.log(`counts=${outer(words)}${outer(pairs)}${count([7])}`)
