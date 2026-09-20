// @ts-nocheck
// propertyHelper.js's `isWritable(obj, name, verifyProp, value)` as the harness
// spells it: `verifyProp` is null at `verifyNotWritable`'s sites, absent at
// `verifyProperty`'s, a string at a few -- and `obj[verifyProp || name]` merges
// them. test262 `String/prototype/*/S15.*_A10.js` (charAt.length is read-only).
//! expect: false false
//! expect: true 1
var __isArray = Array.isArray
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
function isSameValue(a, b) {
  if (a === 0 && b === 0) return 1 / a === 1 / b
  if (a !== a && b !== b) return true
  return a === b
}
function isWritable(obj, name, verifyProp, value) {
  var unlikelyValue = __isArray(obj) && name === 'length' ? 'nonIndex' : 'unlikelyValue'
  var newValue = value || unlikelyValue
  var hadValue = __hasOwnProperty(obj, name)
  var oldValue = obj[name]
  var writeSucceeded
  if (arguments.length < 4 && newValue === oldValue) {
    newValue = newValue + '2'
  }
  try {
    obj[name] = newValue
  } catch (e) {
    if (!(e instanceof TypeError)) throw new Error('Expected TypeError, got ' + e)
  }
  writeSucceeded = isSameValue(obj[verifyProp || name], newValue)
  if (writeSucceeded) {
    if (hadValue) {
      obj[name] = oldValue
    } else {
      delete obj[name]
    }
  }
  return writeSucceeded
}
function verifyNotWritable(obj, name, verifyProp, value) {
  if (isWritable(obj, name, verifyProp, value)) throw new Error('Expected obj[' + String(name) + '] NOT to be writable, but was.')
}
var __obj = String.prototype.charAt.length
verifyNotWritable(String.prototype.charAt, 'length', null, function () {
  return 'shifted'
})
console.log(isWritable(String.prototype.charAt, 'length'), isWritable(String.prototype.charAt, 'length', 'length'))
console.log(String.prototype.charAt.length === __obj, String.prototype.charAt.length)
