//! dynamic-fallback
//! expect: ,a:1,b:"x",c:null,d:true,e:{"f":2} ,err:{"type":"Error","message":"boom"},n:2
// `Object.prototype.hasOwnProperty.call(obj, key)` over a boxed receiver: the
// call is typed `any` in JavaScript, so its boolean answer is boxed into that
// carrier -- pino's asJson loop, with its typeof switch and fall-through.
'use strict'
const serializers = { err: (e) => ({ type: 'Error', message: e.message }) }
const stringifiers = {}
const errorKey = 'err'
function asString (s) { return '"' + s + '"' }
function asJson (obj, msg) {
  let value
  let propStr = ''
  for (const key in obj) {
    value = obj[key]
    if (Object.prototype.hasOwnProperty.call(obj, key) && value !== undefined) {
      if (serializers[key]) {
        value = serializers[key](value)
      } else if (key === errorKey && serializers.err) {
        value = serializers.err(value)
      }
      const stringifier = stringifiers[key]
      switch (typeof value) {
        case 'undefined':
        case 'function':
          continue
        case 'number':
          if (Number.isFinite(value) === false) {
            value = null
          }
        case 'boolean':
          if (stringifier) value = stringifier(value)
          break
        case 'string':
          value = (stringifier || asString)(value)
          break
        default:
          value = JSON.stringify(value)
      }
      if (value === undefined) continue
      propStr += ',' + key + ':' + value
    }
  }
  return propStr
}
const input = JSON.parse('{"a":1,"b":"x","c":1e999,"d":true,"e":{"f":2}}')
console.log(asJson(input), asJson({ err: new Error('boom'), n: 2 }))
