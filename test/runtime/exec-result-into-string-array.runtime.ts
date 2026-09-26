//! expect: 2024 5 6 4 true 2024-05-06|2024|05|06
//! expect: none
//! expect: bc c true 1 abc 3
// `RegExpExecArray extends Array<string>`, and ECMA-262 22.2.7.2 builds the
// exec result as an Array, so it stores into a `string[]` cell as the same
// object. ajv-formats' `const matches: string[] | null = DATE.exec(str)`.
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/
function parts(str: string): string {
  const matches: string[] | null = DATE.exec(str)
  if (!matches) return 'none'
  const year: number = +(matches[1] ?? '')
  return `${year} ${+(matches[2] ?? '')} ${+(matches[3] ?? '')} ${matches.length} ${Array.isArray(matches)} ${matches.join('|')}`
}
console.log(parts('2024-05-06'))
console.log(parts('x'))
const m = /b(c)?(z)?/.exec('abc')
if (m) console.log(m[0], m[1], m[2] === undefined, m.index, m.input, m.length)
