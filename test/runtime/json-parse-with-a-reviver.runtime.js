// @ts-nocheck
//! dynamic-fallback
//! expect: {"a":2,"list":[2,4],"nested":{"b":6}} root
//! expect: {"a":1}
// JSON.parse's reviver (25.5.1.1 InternalizeJSONProperty): each property is
// rewritten -- or deleted when the reviver answers `undefined` -- bottom-up,
// with its holder as `this` and the root under the empty key
// (secure-json-parse's `_parse(text, reviver, options)`).
function parse (text, reviver) { return JSON.parse(text, reviver) }
let rootKey = null
const doubled = parse('{"a":1,"list":[1,2],"nested":{"b":3},"drop":0}', function (key, value) {
  if (key === '') rootKey = this[''] === value ? 'root' : 'wrong'
  if (key === 'drop') return undefined
  return typeof value === 'number' ? value * 2 : value
})
console.log(JSON.stringify(doubled), rootKey)
console.log(JSON.stringify(parse('{"a":1}', undefined)))
