interface TextRange {
  pos: number
  end: number
}
interface Nd extends TextRange {
  kind: number
  parent?: Nd
  flags: number
}
interface Ident extends Nd {
  text: string
}
interface Lit extends Nd {
  value: number
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
function setTextRange<T extends TextRange>(range: T, location: TextRange | undefined): T {
  if (location) {
    range.pos = location.pos
    range.end = location.end
  }
  return range
}
function update<T extends Nd>(updated: Mutable<T>, original: T): T {
  if (updated !== original) setTextRange(updated, original)
  return updated
}
const a: Ident = { pos: 0, end: 1, kind: 1, flags: 0, text: 'x' }
const b: Ident = { pos: 5, end: 9, kind: 1, flags: 0, text: 'y' }
const c: Lit = { pos: 2, end: 3, kind: 2, flags: 0, value: 4 }
console.log(update(a, b).pos, update(c, c).end)
//! expect: 5 3
