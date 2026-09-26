//! expect: 3 1 2 -1 -1
//! expect: true true false 3

// `indexOf`, `lastIndexOf` and `includes` over an Array whose elements are
// boxed (`gea::ArrayObject<gea::Value>`). The element comparison was `==`,
// which `gea::Value` does not declare, so the program failed to compile in
// C++; `includes` was ambiguous as well, because ADL on `gea::Value` also
// finds the keyed collections' `gea::sameValueZero`. NaN is the one element
// the two comparisons disagree on: `indexOf` misses it, `includes` finds it.
const values: any[] = JSON.parse('[1, "x", null, 2]')
const two: any = JSON.parse('2')
const x: any = JSON.parse('"x"')
const nil: any = JSON.parse('null')
const three: any = JSON.parse('3')
const nan: any = two / 0 - two / 0
values.push(nan)
console.log(values.indexOf(two), values.indexOf(x), values.indexOf(nil), values.indexOf(three), values.indexOf(nan))
console.log(values.includes(nan), values.includes(x), values.includes(three), values.lastIndexOf(two))
