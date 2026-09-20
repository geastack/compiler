// A `Promise<never>` RETURNED WHERE A `Promise<T>` IS DECLARED.
//
// `@hono/node-server`'s `readBodyWithFastPath<T>` opens with
// `if (request[bodyConsumedDirectlyKey]) return rejectBodyUnusable()`, where
// `rejectBodyUnusable(): Promise<never>` is `Promise.reject(...)`. TypeScript
// admits that at every instantiation because `never` is assignable to every
// `T`, and it is physically sound for the same reason: a `Promise<never>` can
// only reject or stay pending, so the fulfillment channel the target's payload
// would be read out of is never written.
//
// `never` and `void` share one carrier, so the pair reaching the conversion
// census reads `promise(void) -> promise(string)` -- which the backend refused,
// correctly for a genuine `Promise<void>` (a void promise CAN settle, and there
// is no value to hand the target) and wrongly for this one.

const rejectUnusable = (): Promise<never> => Promise.reject(new TypeError('body unusable'))

const readWithFastPath = <T>(consumed: boolean, fromBuffer: (buffer: string) => T): Promise<T> => {
  if (consumed) {
    return rejectUnusable()
  }
  return Promise.resolve(fromBuffer('payload'))
}

//! expect: text=payload!
console.log('text=' + (await readWithFastPath(false, (buffer) => buffer + '!')))

//! expect: length=7
console.log('length=' + (await readWithFastPath(false, (buffer) => buffer.length)))

//! expect: text-rejected=TypeError: body unusable
try {
  await readWithFastPath(true, (buffer) => buffer + '!')
} catch (raised) {
  console.log('text-rejected=' + String(raised))
}

//! expect: length-rejected=TypeError: body unusable
try {
  await readWithFastPath(true, (buffer) => buffer.length)
} catch (raised) {
  console.log('length-rejected=' + String(raised))
}

// The same shape without a type parameter: a plain `Promise<never>` returned
// from a body declared `Promise<string>`.
const alwaysFails = (fail: boolean): Promise<string> => (fail ? rejectUnusable() : Promise.resolve('ok'))

//! expect: plain=ok
console.log('plain=' + (await alwaysFails(false)))

//! expect: plain-rejected=TypeError: body unusable
try {
  await alwaysFails(true)
} catch (raised) {
  console.log('plain-rejected=' + String(raised))
}
