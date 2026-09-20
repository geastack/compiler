//! expect: the user aborted a request
//! expect: code 42

// Node implements `console.info` as an alias of `console.log`; the one call
// site this target builds is `@hono/node-server`'s recoverable client-abort
// path, which refused by name until the member had a row.
console.info('the user aborted a request')
console.info('code', 42)
