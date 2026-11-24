// `Object.assign({}, value)` copies an `any` value, so the copy's own keys are
// whatever the value held, `$scope` among them. Storing the recursive `any`
// result back under `$scope` writes the copy's dynamic own-property table;
// the stored Value is the very object the recursion returned.

export {}

function deserialize(value: any): any {
  if (typeof value !== 'object' || value === null) return value
  if (value.$code != null) {
    const copy = Object.assign({}, value)
    if (value.$scope) {
      copy.$scope = deserialize(value.$scope)
    }
    return copy
  }
  return value
}

const parsed = JSON.parse('{"$code":"x()","$scope":{"a":1}}')
const out = deserialize(parsed)
console.log(out.$code, JSON.stringify(out.$scope), out === parsed, out.$scope === parsed.$scope)
const bare = deserialize(JSON.parse('{"$code":"y()"}'))
console.log(bare.$code, bare.$scope)

//! expect: x() {"a":1} false true
//! expect: y() undefined
