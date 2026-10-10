// ECMA-262 27.2.5.4 hands both handlers to `PerformPromiseThen`, and a handler
// that is not callable is ABSENT there: `then(undefined, g)` is `catch(g)` and
// `then(f, undefined)` is `then(f)`. A database client spells every
// fire-and-forget close as `close().then(undefined, squashError)`, and hands a
// Node-style `(error?, result?) => void` callback as the rejection handler --
// the reaction supplies only the reason and the second parameter is bound to
// `undefined`.

type Callback<T = any> = (error?: Error, result?: T) => void

const ok: Promise<number> = Promise.resolve(7)
const bad: Promise<number> = ok.then((n: number): number => {
  if (n > 0) throw new Error('boom')
  return n
})

const squash = (e: unknown): void => {
  console.log('squashed=' + (e instanceof Error ? e.message : 'other'))
}

//! expect: squashed=boom
void bad.then(undefined, squash)

//! expect: passed=7
console.log('passed=' + (await ok.then(undefined, (_e: unknown): number => -1)))

//! expect: fallback=-1
console.log('fallback=' + (await bad.then(undefined, (_e: unknown): number => -1)))

//! expect: only-fulfilled=8
console.log('only-fulfilled=' + (await ok.then((n: number): number => n + 1, undefined)))

const listener: Callback = (error?: Error, result?: any): void => {
  console.log('callback=' + (error ? error.message : 'none') + ':' + (result === undefined ? 'undefined' : 'set'))
}
//! expect: callback=boom:undefined
await bad.then(undefined, listener)
