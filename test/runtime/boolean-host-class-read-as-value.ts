//! expect: false,true,true
//! expect: 1,3

// `Boolean` read as a value is the class's CALL half, and `Boolean(x)` is
// ToBoolean(x) (ECMA-262 20.3.1.1). So the thunk's body is this backend's own
// per-carrier ToBoolean, not one C++ function: an empty string is false where
// a non-empty one is true, and a zero is false where any other number is true.
const texts = ['', 'x', '0']
console.log(texts.map(Boolean).join(','))

const counts = [1, 0, 3]
console.log(counts.filter(Boolean).join(','))
