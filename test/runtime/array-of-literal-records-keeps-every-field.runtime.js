//! dynamic-fallback
//! expect: true false [{"instancePath":"/x","schemaPath":"#/type","keyword":"type","params":{"type":"string"},"message":"must be string"}] false [{"instancePath":"/x","schemaPath":"#/pattern","keyword":"pattern","params":{"pattern":"idle"},"message":"must match pattern \"idle\""}] false [{}]
// An array cell written with arrays of distinct object literals -- full
// error records and `{}` -- holds an array of their union, every read of it
// keeps that carrier, and storing it on a function's own property boxes it
// as it is: fastify's precompiled config validator and its `vErrors`.
'use strict'
const pattern0 = /idle/
function validate10 (data, { instancePath = '' } = {}) {
  let vErrors = null
  let errors = 0
  if (typeof data !== 'string') {
    const err0 = { instancePath: instancePath + '/x', schemaPath: '#/type', keyword: 'type', params: { type: 'string' }, message: 'must be string' }
    if (vErrors === null) vErrors = [err0]
    else vErrors.push(err0)
    errors++
  } else if (data === 'if') {
    const err4 = {}
    if (vErrors === null) vErrors = [err4]
    else vErrors.push(err4)
    errors++
  } else if (!pattern0.test(data)) {
    const err1 = { instancePath: instancePath + '/x', schemaPath: '#/pattern', keyword: 'pattern', params: { pattern: 'idle' }, message: 'must match pattern "idle"' }
    if (vErrors === null) vErrors = [err1]
    else vErrors.push(err1)
    errors++
  }
  validate10.errors = vErrors
  return errors === 0
}
console.log(validate10('idle'), validate10(3), JSON.stringify(validate10.errors), validate10('busy'), JSON.stringify(validate10.errors), validate10('if'), JSON.stringify(validate10.errors))
