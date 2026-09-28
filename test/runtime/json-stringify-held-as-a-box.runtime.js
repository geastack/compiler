// @ts-nocheck
//! dynamic-fallback
//! expect: {"a":[1,"x"]} undefined "s"
// @pinojs/redact's `const { serialize = JSON.stringify } = options`: the
// function object held by a box.
function make (options = {}) {
  const { serialize = JSON.stringify } = options
  return serialize
}
const serialize = make(JSON.parse('{}'))
console.log(serialize(JSON.parse('{"a":[1,"x"]}')), serialize(undefined), serialize('s'))
