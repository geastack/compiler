// @ts-nocheck
//! expect: TypeError Cannot set properties of undefined
// fastify's `getServerInstance` stores `server.closeHttp2Sessions` after a
// call that cannot return: the receiver is typed `never`, and a store through
// a nullish base throws.
function never () {
  throw new TypeError('Cannot set properties of undefined')
}
try {
  const server = never()
  server.closeSessions = true
} catch (e) {
  console.log(e.name, e.message)
}
