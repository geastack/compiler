//! expect: B D D
//! expect: BD D D
//! expect: S N D D
// A case that can fall through into `default`, and one that falls into the
// next case: each clause's test is evaluated where that clause begins, after
// the bodies before it. With the tests ordered after the whole switch, the
// `default` body -- gated by no earlier test -- ran first, and `kind(1, true)`
// returned 'D' instead of 'B' (safe-stable-stringify's `case 'bigint'`).
/**
 * @param {number} value
 * @param {boolean} flag
 */
function kind(value, flag) {
  switch (value) {
    case 1:
      if (flag) {
        return 'B'
      }
    // fallthrough
    default:
      return 'D'
  }
}
console.log(kind(1, true), kind(1, false), kind(2, true))
/**
 * @param {number} value
 * @param {boolean} flag
 */
function collect(value, flag) {
  let out = ''
  switch (value) {
    case 1:
      if (flag) {
        out += 'B'
      }
    // fallthrough
    case 2:
      out += 'D'
  }
  return out
}
console.log(collect(1, true), collect(1, false), collect(2, true), collect(3, true))
/** @param {unknown} value */
function typeName(value) {
  switch (typeof value) {
    case 'string':
      return 'S'
    case 'number':
      return 'N'
    case 'bigint':
      if (value === 1n) {
        return 'B'
      }
    // fallthrough
    default:
      return 'D'
  }
}
console.log(typeName('a'), typeName(1), typeName(2n), typeName(true))
