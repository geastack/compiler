//! expect: 97 3 103 105
//! expect: before after
//! emitted-has: .callKnownBorrowed<

function firstCode(text: string): number {
  return text.charCodeAt(0)
}
function textLength(text: string): number {
  return text.length
}
const methods = { read: firstCode }
function invoke(text: string): number {
  return methods.read(text)
}
const initial = invoke('abc')
methods.read = textLength
const replacement = invoke('abc')
function captured(offset: number): (text: string) => number {
  return (text: string): number => text.length + offset
}
methods.read = captured(100)
const one = invoke('abc')
methods.read = captured(102)
console.log(initial, replacement, one, invoke('abc'))

const holder = { text: 'before' }
function pure(text: string): string {
  return text
}
function mutating(text: string): string {
  holder.text = 'after'
  return text
}
const snapshots = { read: pure }
function readSnapshot(): string {
  return snapshots.read(holder.text)
}
snapshots.read = mutating
console.log(readSnapshot(), holder.text)
