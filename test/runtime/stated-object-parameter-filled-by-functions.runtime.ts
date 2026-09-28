//! expect: use require("ucs2length") | use require("equal") 3 true
// A stated object type every caller fills with a function object carrying its
// members holds those functions, not a record: ajv's
// `useFunc(gen, f: {code: string})` over `ucs2length`, `equal` and friends.
function useFunc(f: { code: string }): string {
  return 'use ' + f.code
}
function ucs2length(str: string): number {
  return str.length
}
ucs2length.code = 'require("ucs2length")'
function equal(a: unknown, b: unknown): boolean {
  return a === b
}
equal.code = 'require("equal")'
console.log(useFunc(ucs2length), '|', useFunc(equal), ucs2length('abc'), equal(1, 1))
