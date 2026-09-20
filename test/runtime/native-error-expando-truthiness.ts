// A native Error used through `any` keeps its native carrier and stores the
// additional property in the generic dynamic-property sidecar. The assertion
// must not invent a C++ member on Error or box the typed object.
const tagged = new Error('boom')
;(tagged as any).code = 'E_BOOM'

//! expect: E_BOOM
console.log((tagged as any).code)

// Removing one absence arm from a three-arm union still leaves an optional
// carrier. The conversion must preserve that carrier around the native Error
// payload so ToBoolean reads a real presence flag rather than calling
// `.has_value()` on a bare Ref.
function describe(error: Error | null | undefined): string {
  if (error) return error.message
  return 'none'
}

//! expect: boom
console.log(describe(tagged))

//! expect: none
console.log(describe(null))

//! expect: none
console.log(describe(undefined))
