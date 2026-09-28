// @ts-nocheck
//! dynamic-fallback
//! expect: function done
// fastify's `lib/promise.js`: `Promise.withResolvers.bind(Promise)` held as a
// module export, called later.
const exported = {
  withResolvers: typeof Promise.withResolvers === 'function' ? Promise.withResolvers.bind(Promise) : null
}
const { promise, resolve } = exported.withResolvers()
console.log(typeof resolve, 'done')
resolve(1)
void promise
