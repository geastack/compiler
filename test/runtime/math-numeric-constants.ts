export {}

// The eight numeric constants of 21.3.1. Each is a non-writable,
// non-enumerable, non-configurable own data property of `Math`, and each must
// be reachable both as a direct read and reflectively.
const direct = [Math.E, Math.LN10, Math.LN2, Math.LOG10E, Math.LOG2E, Math.PI, Math.SQRT1_2, Math.SQRT2]

console.log(
  `${direct.map((value) => typeof value).join(',')}|${direct.every((value) => value === value)}|${Math.E.toFixed(3)}|${Math.LN10.toFixed(3)}|${Math.LN2.toFixed(3)}`
)

//! expect: number,number,number,number,number,number,number,number|true|2.718|2.303|0.693
