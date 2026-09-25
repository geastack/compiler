//! dynamic-fallback
//! expect: 2:logger
// pino's `asJson`: `const store = { instance: this, arguments }` reads the
// arguments object through a shorthand property, where the checker's symbol
// at the name is the literal's own property rather than the value it reads.
'use strict'
function asJson(obj, msg) {
  const store = { instance: this, arguments }
  return store.arguments.length + ':' + store.instance.name
}
console.log(asJson.call({ name: 'logger' }, { a: 1 }, 'm'))
