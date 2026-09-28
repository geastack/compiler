// @ts-nocheck
//! dynamic-fallback
//! expect: 3 a,b,c
// light-my-request's multipart body: an `async function*`'s generator handed
// to a consumer that takes any iterable, as a box, and walks it with `for await`.
async function * parts () {
  yield 'a'
  yield 'b'
  yield 'c'
}
/** @param {any} source */
async function collect (source) {
  const seen = []
  for await (const part of source) seen.push(part)
  return seen
}
collect(parts()).then((seen) => console.log(seen.length, seen.join(',')))
