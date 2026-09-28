// @ts-nocheck
//! dynamic-fallback
//! expect: boom Error true X
//! expect: undefined-message true
// An error the program decorates and passes around dynamically is still the
// intrinsic error object.
function make(m) {
  const e = new Error(m)
  e.code = 'X'
  return e
}
const e = make(JSON.parse('"boom"'))
console.log(e.message, e.name, e instanceof Error, e.code)
const bare = new TypeError(JSON.parse('null') ?? undefined)
console.log(bare.message === '' ? 'undefined-message' : bare.message, bare instanceof TypeError)
