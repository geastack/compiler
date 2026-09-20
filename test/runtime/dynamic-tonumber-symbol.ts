//! expect-abort
//! dynamic-fallback

function number(value: number): number {
  return value
}

const value: any = Symbol('must-not-number')
console.log(number(value))
