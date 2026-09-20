// `T | undefined === c` -- ECMA-262 7.2.16 IsStrictlyEqual over an `optional`.
//
// `gea::Optional<T>` is a two-arm sum whose discriminant is `has_value()`, so
// the rule is the same two steps a tagged union gets: the presence test is
// step 1 ("if Type(x) is not Type(y), return false" -- an absent optional's
// Type is Undefined and a present `false` is a Boolean), and the payload's own
// comparison is step 2.
//
// The step-1 half is the one only a running program can check. A comparison
// that unwrapped without testing presence reads a default-constructed payload
// -- `false` for a `bool`, `""` for a string -- so `absent === false` and
// `absent === ''` would both answer TRUE, in C++ that compiles and in a shape
// clang has nothing to say about. Before this, the whole comparison refused to
// emit ("binary === mixes a optional and a scalar carrier"), so a wrong answer
// was never the risk; a wrong answer is exactly the risk in fixing it.
//
// Every line below is checked against node's own output for this file.
const maybeFlag = (present: boolean): boolean | undefined => (present ? false : undefined)
const maybeText = (present: boolean): string | undefined => (present ? '' : undefined)

//! expect: absent-vs-true=false
console.log('absent-vs-true=' + (maybeFlag(false) === true))

// THE case. Both the absent optional and the literal are falsy, and the
// payload a presence-blind unwrap would read is bit-for-bit the literal.
//! expect: absent-vs-false=false
console.log('absent-vs-false=' + (maybeFlag(false) === false))

//! expect: present-vs-false=true
console.log('present-vs-false=' + (maybeFlag(true) === false))

//! expect: present-vs-true=false
console.log('present-vs-true=' + (maybeFlag(true) === true))

// The literal on the LEFT: the same comparison, and the emitter may not decide
// which side is the sum by position.
//! expect: reversed=true/false
console.log('reversed=' + (false === maybeFlag(true)) + '/' + (false === maybeFlag(false)))

// `!==` is the negation of the whole rule, not a comparison of its own.
//! expect: not-equal=true/false
console.log('not-equal=' + (maybeFlag(false) !== false) + '/' + (maybeFlag(true) !== false))

// The same two steps over a string payload, where the empty string is the
// default-constructed value a presence-blind unwrap would read.
//! expect: text=false/true
console.log('text=' + (maybeText(false) === '') + '/' + (maybeText(true) === ''))

//! expect: text-not-equal=true/false
console.log('text-not-equal=' + (maybeText(false) !== '') + '/' + (maybeText(true) !== ''))
