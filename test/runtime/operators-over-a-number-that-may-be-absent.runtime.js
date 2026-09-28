// @ts-nocheck
//! expect: false true NaN 1 2 NaN
// sonic-boom's `sonic._len > sonic.minLength` and thread-stream's
// `++stream[kImpl].nextFlushId` over fields typed `number | undefined`:
// ToNumber(undefined) is NaN, before the operator runs.
/** @typedef {{ len: number | undefined, min: number | undefined, id: number | undefined }} Sonic */
/** @returns {Sonic} */
function make (len) {
  return len ? { len, min: 1, id: 0 } : { len: undefined, min: undefined, id: undefined }
}
const a = make(0)
const b = make(5)
console.log(a.len > a.min, b.len > b.min, a.len - b.min, ++b.id, ++b.id, ++a.id)
