//! expect: declared key present x
//! expect: union array present present a
//! expect: reassigned let present computed
//! expect: fallback let present d
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
