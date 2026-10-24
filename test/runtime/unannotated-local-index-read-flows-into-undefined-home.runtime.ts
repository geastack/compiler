//! expect: unknown parameter missing undefined
//! expect: unknown parameter present present x
//! expect: any parameter missing undefined
//! expect: optional parameter missing undefined
//! expect: console.log missing undefined
//! expect: unknown slot missing true
//! expect: optional return missing true
//! expect: optional return present x
//! expect: symbol key unknown parameter missing undefined
//! expect: symbol key compared missing true
//! expect: symbol key unknown parameter present present y
//! expect: untyped let guard no node
// With `noUncheckedIndexedAccess` off the checker types a missing key's read
// as `string`. An unannotated local holding that read is widened to
// `string | undefined` only where a use observes the absence. A use whose
// destination has a home for `undefined` -- an `unknown`/`any` parameter,
// `console.log`, an `unknown` slot, an optional return -- is such a use, as it
// already is for the read itself: `consume(words[key])` and
// `const value = words[key]; consume(value)` must answer the same.
interface Words {
  [name: string]: string
}
const words: Words = { a: 'x' }
function consume(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeAny(value: any): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeOptional(value: string | undefined): string {
  return value === undefined ? 'undefined' : 'present ' + value
}
function lookup(key: string): string | undefined {
  const value = words[key]
  return value
}
const missing = words['b']
console.log('unknown parameter missing', consume(missing))
const present = words['a']
console.log('unknown parameter present', consume(present))
const missingAny = words['c']
console.log('any parameter missing', consumeAny(missingAny))
const missingOptional = words['d']
console.log('optional parameter missing', consumeOptional(missingOptional))
const logged = words['e']
console.log('console.log missing', logged)
const held = words['f']
const slot: unknown = held
console.log('unknown slot missing', slot === undefined)
console.log('optional return missing', lookup('g') === undefined)
console.log('optional return present', lookup('a'))
// A `[key: symbol]` signature is a dictionary too; the census finds it among
// the index infos, since `IndexKind` names only string and number.
interface Marks {
  [key: symbol]: string
}
const presentMark = Symbol('present')
const absentMark = Symbol('absent')
const marks: Marks = {}
marks[presentMark] = 'y'
const missingMark = marks[absentMark]
console.log('symbol key unknown parameter missing', consume(missingMark))
const comparedMark = marks[absentMark]
console.log('symbol key compared missing', comparedMark === undefined)
const presentByMark = marks[presentMark]
console.log('symbol key unknown parameter present', consume(presentByMark))
// Hono's RegExpRouter shape (#19): the `any` of an untyped local's assignment
// is no home for `undefined`; the read keeps its own carrier and the guard
// observes the absence.
let node
node = words['h']
console.log('untyped let guard', node ? 'node' : 'no node')
