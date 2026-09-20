//! expect-abort
//! dynamic-fallback

function text(value: string): string {
  return value
}

const value: any = Symbol('must-not-stringify')
console.log(text(value))
