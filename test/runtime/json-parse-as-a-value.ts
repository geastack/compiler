// `JSON.parse` PASSED AS A CALLBACK, NEVER CALLED BY NAME.
//
// `@hono/node-server`'s `LightRequest.json` is `this.text().then(JSON.parse)`.
// `JSON.parse` is an ordinary function object in ECMAScript; what this backend
// has instead is a per-call-site rendering, generated from the type the call
// site asserts -- so the two JSON rows in `host-members.ts` carry a
// PLACEHOLDER template, and filling the generic host-method thunk from it
// would have spliced that placeholder's comment in where the call belongs.
//
// The value form renders the same body the call form does. It is narrower on
// purpose: `gea_runtime.h` declares `gea_json_read` for `gea::Value`, a
// string and a number itself, while every record shape's overload is generated
// from a walk over CALL sites that a value read contributes nothing to.
// `JSON.parse` with no assertion is the case that matters, and its result is
// `any` -- the genuinely dynamic boundary, not a typed value being boxed.

//! expect: direct=7
console.log('direct=' + String(await Promise.resolve('7').then(JSON.parse)))

//! expect: deferred=hello
console.log('deferred=' + String(await Promise.resolve('"hello"').then(JSON.parse)))
