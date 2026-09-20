//! expect-abort
//! dynamic-fallback

function takesNumber(value: number): number {
  return value + 1
}

// A TypeScript number slot is an exact Number-tag assertion. A dynamic Symbol
// must not be silently coerced merely because the annotation says `number`.
const value: any = Symbol('not-a-number')
console.log(takesNumber(value))
