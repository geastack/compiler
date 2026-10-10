// ECMA-262 20.1.2.23: `Object.values` of a record whose fields carry different
// types. A database client validates `CANONICALIZE_HOST_NAME` with
// `Object.values(GSSAPICanonicalizationValue).includes(value)`, where the frozen
// table maps names to `true | false | 'none' | ...`; each field widens into the
// `(boolean | string)[]` element in declaration order.

const Canonicalization = Object.freeze({
  on: true,
  off: false,
  none: 'none',
  forward: 'forward'
} as const)
type Canonicalization = (typeof Canonicalization)[keyof typeof Canonicalization]

function isValid(value: Canonicalization | string | boolean): boolean {
  return (Object.values(Canonicalization) as (string | boolean)[]).includes(value)
}

const values = Object.values(Canonicalization)
//! expect: count=4 values=true,false,none,forward
console.log('count=' + values.length + ' values=' + values.join(','))
//! expect: on=true none=true reverse=false
console.log('on=' + isValid(true) + ' none=' + isValid('none') + ' reverse=' + isValid('reverse'))
