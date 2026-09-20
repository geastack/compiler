//! expect: TypeError: bad input
//! expect: Error
//! expect: 97,98
//! expect: 1,2,3

// `Error.prototype.toString` (ECMA-262 20.5.3.4) is the name, the message, or
// "name: message" -- the same algorithm `${e}` already runs, reached here by
// its explicit spelling. The read used to fall through to the dynamic-property
// sidecar, where "toString" is one of Array.prototype's own member names, and
// refused under that prototype's name.
const failure: Error | null = new TypeError('bad input')
if (failure) console.log(failure.toString())
console.log(new Error('').toString())

// `%TypedArray%.prototype.toString` (23.2.3.32) IS `Array.prototype.toString`:
// `join()` with the default comma separator.
const bytes = new Uint8Array([97, 98])
console.log(bytes.toString())
const numbers = new Float64Array([1, 2, 3])
console.log(numbers.toString())
