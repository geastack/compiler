//! dynamic-fallback
//! expect: 0,1,result:undefined,a,b,result:undefined
//! expect: head,a,b,tail
//! expect: TypeError: The iterator does not provide a 'throw' method.
//! expect: true true
// light-my-request's multipart body: `yield * value.stream()` inside an
// `async function*`. The delegation is ECMA-262 15.5.5's loop -- the inner
// iterator's values, what the outer caller resumes with forwarded, `throw`
// and `return` included -- over a boxed iterable, in both generator kinds.
// A property of a literal with an any-typed computed key is a genuinely dynamic value.
const slot = JSON.parse('"source"')
const dynamic = (value) => ({ [slot]: value })[slot]
/** @param {any} source */
function* wrap(source) {
  const result = yield* source
  yield 'result:' + result
}
class Frames {
  constructor(source) {
    this.source = source
  }

  async *[Symbol.asyncIterator]() {
    yield 'head'
    yield* this.source
    yield 'tail'
  }
}
async function main() {
  const all = []
  for (const piece of wrap(dynamic([0, 1]))) all.push(piece)
  for (const piece of wrap(dynamic('ab'))) all.push(piece)
  console.log(all.join(','))
  const frames = []
  for await (const piece of new Frames(dynamic(['a', 'b']))) frames.push(piece)
  console.log(frames.join(','))
  const thrown = wrap(dynamic([0, 1]))
  thrown.next()
  try {
    thrown.throw(new Error('boom'))
  } catch (error) {
    console.log(error.name + ': ' + error.message)
  }
  const returned = wrap(dynamic([0, 1]))
  returned.next()
  console.log(returned.return().done, returned.next().done)
}
main()
