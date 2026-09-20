//! expect-abort
//! dynamic-fallback

function number(value: number): number {
  return value
}

const value: any = 1n
console.log(number(value))
