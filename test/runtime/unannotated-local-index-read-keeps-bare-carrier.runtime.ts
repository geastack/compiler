//! expect: declared key present x
//! expect: union array present present a
//! expect: reassigned let present computed
//! expect: fallback let present d
//! expect: guarded present x skip
//! expect: early return present x skip
//! expect: truthy alias present x skip
//! emitted-lacks: presentOrThrow
//! emitted-lacks: std::string(gea::Optional<
interface Fields {
  a: string
  [name: string]: string
}
interface Words {
  [name: string]: string
}
const fields: Fields = { a: 'x' }
const words: Words = { a: 'x' }
function consumeDeclared(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeUnionArray(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeReassigned(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeFallback(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeGuarded(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeEarly(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeAlias(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function guarded(key: string): string {
  const value = words[key]
  if (value !== undefined) return consumeGuarded(value)
  return 'skip'
}
function earlyReturn(key: string): string {
  const value = words[key]
  if (value === undefined) return 'skip'
  return consumeEarly(value)
}
function truthyAlias(key: string): string {
  const first = words[key]
  if (first) {
    const second = first
    return consumeAlias(second)
  }
  return 'skip'
}
function pickArray(strings: boolean): string[] | number[] {
  return strings ? ['a'] : [1]
}
function compute(): string {
  return 'computed'
}
const declared = fields['a']
console.log('declared key', consumeDeclared(declared))
const elements = pickArray(true)
const element = elements[0]
console.log('union array present', consumeUnionArray(element))
let reassigned = words['missing']
reassigned = compute()
console.log('reassigned let', consumeReassigned(reassigned))
let fallback = words['missing']
if (fallback === undefined) fallback = 'd'
console.log('fallback let', consumeFallback(fallback))
console.log('guarded', guarded('a'), guarded('b'))
console.log('early return', earlyReturn('a'), earlyReturn('b'))
console.log('truthy alias', truthyAlias('a'), truthyAlias('b'))
