//! expect: direct:42
//! expect: dynamic:42
//! emitted-has: gea::callableDynamicSet
//! emitted-has: gea::callableDynamicGet

interface AugmentedFunction {
  (): void
  default?: number
}

const entry: AugmentedFunction = function () {}
entry.default = 42

// This is the native callable read, not the dynamic boundary below.
console.log(`direct:${entry.default}`)

// Crossing into `any` must preserve the one function object's sidecar rather
// than allocating a box-local table.
const observed: any = entry
console.log(`dynamic:${observed.default}`)
