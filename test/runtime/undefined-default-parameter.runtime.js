//! dynamic-fallback
//! expect: listening 3000
//! expect: no callback 0 2
// fastify's `listen (listenOptions = {...}, cb = undefined)`: the default is a
// no-op on the parameter's values, so a caller may pass a callback, and the
// function's length still stops at the first defaulted parameter.
'use strict'
function listen(listenOptions = { port: 0 }, cb = undefined) {
  if (typeof cb === 'function') {
    cb(null, listenOptions.port)
    return
  }
  console.log('no callback', listenOptions.port, listen.length + 2)
}
listen({ port: 3000 }, (error, port) => {
  console.log('listening', port)
})
listen()
