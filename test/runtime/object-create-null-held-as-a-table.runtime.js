// @ts-nocheck
//! dynamic-fallback
//! expect: b 1
//! expect: 0 true
// fast-uri's `headers = Object.create(null)` and ajv's
// `formats = Object.create(null)`: a null prototype and no own keys is exactly
// the empty table the declaration asks for.
let headers = null
for (const [k, v] of [['a', 'b']]) {
  if (headers === null) headers = /** @type {Record<string,string>} */ (Object.create(null))
  headers[k] = v
}
console.log(headers.a, Object.keys(headers).length)
class Core {
  constructor () {
    /** @type {{[name: string]: {validate: string} | undefined}} */
    this.formats = Object.create(null)
  }
}
const core = new Core()
console.log(Object.keys(core.formats).length, core.formats.missing === undefined)
