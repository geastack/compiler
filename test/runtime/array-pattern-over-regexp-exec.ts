// tsc semver.ts:145 -- `const [, major, minor = "0", patch = "0", prerelease
// = "", build = ""] = match` over a `RegExpExecArray`. The pattern's shared
// source step over a native record asked for a
// `destructuring:array-pattern:native-record-ref` helper no manifest claims
// (12 rows on the self-compile). An exec result is the third source whose
// snapshot the array pattern can take in place of a cursor (after `string`
// and `Set`): the runtime holds every capture slot already, and ECMA-262
// 22.2.7.2 puts `undefined` in a non-participating group's slot, so the
// snapshot element is `optional(string)` and each default fires exactly where
// node's does.
const versionRegExp = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:-([a-z0-9-.]+))?(?:\+([a-z0-9-.]+))?)?)?$/i

function parse(text: string): string {
  const match = versionRegExp.exec(text)
  if (!match) return 'none'
  const [, major, minor = '0', patch = '0', prerelease = '', build = ''] = match
  return `${major}.${minor}.${patch}${prerelease ? '-' + prerelease : ''}${build ? '+' + build : ''}`
}

function whole(text: string): string {
  const match = /(\d+)-(\d+)/.exec(text)
  if (!match) return 'none'
  const [all, first, second] = match
  return `${all}|${first}|${second}`
}

console.log(parse('1.2.3'), parse('4'), parse('5.6'), parse('7.8.9-beta.1+build.2'), parse('x'))
console.log(whole('id 12-34 ok'), whole('nope'))
//! expect: 1.2.3 4.0.0 5.6.0 7.8.9-beta.1+build.2 none
//! expect: 12-34|12|34 none
