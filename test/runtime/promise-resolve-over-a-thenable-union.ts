// `Promise.resolve(x)` WHERE `x` IS EITHER THE VALUE OR A PROMISE OF IT.
//
// hono's `resolveCallback` ends in `return Promise.resolve(str)` with `str`
// carried as `string | Promise<string>` -- the two `instanceof` tests above it
// narrow away the object arm but leave both of these -- while TypeScript types
// the call `Promise<string>`, because `Awaited<T>` collapses a thenable into
// its payload.
//
// ECMA-262 27.2.4.7 is a per-VALUE test, not a type-level one: step 2 returns
// a promise whose constructor is this one unchanged, step 3 wraps anything
// else. The carrier keeps exactly that test as its discriminant, so each arm
// renders its own answer. Reading the union as one answer would either wrap a
// promise in a promise or hand back an unwrapped string.

const pick = (deferred: boolean): string | Promise<string> => (deferred ? Promise.resolve('deferred') : 'direct')

const settled = (value: string | Promise<string>): Promise<string> => Promise.resolve(value)

//! expect: direct=direct
console.log('direct=' + (await settled(pick(false))))

//! expect: deferred=deferred
console.log('deferred=' + (await settled(pick(true))))

// Identity, not a wrapper: 27.2.4.7 step 2 hands the very same promise back,
// so a rejection already parked on it is still the one that surfaces.
const failing: string | Promise<string> = Promise.resolve('x').then((): string => {
  throw 'inner'
})

//! expect: adopted=inner
console.log('adopted=' + (await settled(failing).catch((e: unknown): string => String(e))))
