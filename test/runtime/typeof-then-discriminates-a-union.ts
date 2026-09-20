// `typeof x.then === 'function'` AS THE DISCRIMINANT OF A UNION WHOSE ARMS
// DISAGREE ABOUT `then`.
//
// `@hono/node-server`'s `isPromise` is exactly this: a `Response |
// Promise<Response>` narrowed by reading `then` off it and asking whether the
// read produced a callable. `promise-method-read-as-value.ts` covers the
// easier shape, where every arm IS a promise and the answer is the same on all
// of them. Here the arms disagree -- a class instance has no `then` at all --
// so the answer is per-arm and the read is a genuine discriminant rather than
// a settled constant.
//
// The `as` cast is the program's own, and it is a lie on one arm by design:
// TypeScript hands the member the promise's `then` type, while the value it is
// read off may be the class. Folding the answer from the STATIC type would say
// "function" for both arms and route every plain instance down the promise
// path.

class Reply {
  constructor(readonly body: string) {}
}

const thenable = (value: Reply | Promise<Reply>): boolean => typeof (value as Promise<Reply>).then === 'function'

const settle = async (value: Reply | Promise<Reply>): Promise<string> => (thenable(value) ? (await value).body : (value as Reply).body)

const plain: Reply | Promise<Reply> = new Reply('direct')
const deferred: Reply | Promise<Reply> = Promise.resolve(new Reply('awaited'))

//! expect: plain-thenable=false
console.log('plain-thenable=' + thenable(plain))

//! expect: deferred-thenable=true
console.log('deferred-thenable=' + thenable(deferred))

//! expect: plain=direct
console.log('plain=' + (await settle(plain)))

//! expect: deferred=awaited
console.log('deferred=' + (await settle(deferred)))
