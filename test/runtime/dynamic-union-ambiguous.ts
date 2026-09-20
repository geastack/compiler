//! expect-abort
//! dynamic-fallback
//! emitted-has: dynamic value admitted by no union arm

function stringOrNumber(value: string | number): string | number {
  return value
}

// Neither union arm's exact runtime classifier admits Boolean. The union must
// refuse rather than treating a TypeScript annotation as a coercive fallback.
const value: any = true
console.log(stringOrNumber(value))
