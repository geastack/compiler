// @ts-nocheck
/// <reference lib="es2024.promise" />
//! dynamic-fallback
//! expect: host:1 fallback:2 true true
// fastify's `lib/promise.js`: `Promise.withResolvers.bind(Promise)` when the
// host has it, else a fallback that captures the executor's resolving
// functions in `let` variables only the executor's closure writes. Both are
// called through one exported member whose convention is the fallback's.
function withResolvers () {
  let res, rej
  const promise = new Promise((resolve, reject) => {
    res = resolve
    rej = reject
  })
  return { promise, resolve: res, reject: rej }
}
const api = {
  withResolvers: typeof Promise.withResolvers === 'function' ? Promise.withResolvers.bind(Promise) : withResolvers,
  fallback: withResolvers
}
const host = api.withResolvers()
const local = api.fallback()
host.promise.then((first) =>
  local.promise.then((second) => {
    console.log('host:' + first, 'fallback:' + second, typeof host.reject === 'function', typeof local.reject === 'function')
  })
)
host.resolve(1)
local.resolve(2)
