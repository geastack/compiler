//! expect: missing missing missing
//! expect: 17 17 17
//! expect: 23 23 23
//! expect: missing missing missing
//! expect: absent
//! expect: 0
//! expect: optional-missing
//! expect: declared
class Single {
  constructor(public value: number) {}
}
class Group {
  constructor(public children: number[]) {}
}
type Entry = Single | Group
const table: Record<string, Entry> = {}
function named(): string {
  const entry = table.projectionMatrix
  if (entry === undefined) return 'missing'
  if (!(entry instanceof Single)) throw new Error('wrong entry')
  return String(entry.value)
}
function computed(key: string): string {
  const entry = table[key]
  if (entry === undefined) return 'missing'
  return entry instanceof Single ? String(entry.value) : 'group'
}
function truthy(): string {
  const entry = table.projectionMatrix
  return entry ? (entry instanceof Single ? String(entry.value) : 'group') : 'missing'
}
console.log(named(), computed('projectionMatrix'), truthy())
table.projectionMatrix = new Single(17)
console.log(named(), computed('projectionMatrix'), truthy())
table.projectionMatrix = new Single(23)
console.log(named(), computed('projectionMatrix'), truthy())
delete table.projectionMatrix
console.log(named(), computed('projectionMatrix'), truthy())
console.log(table.missing === undefined ? 'absent' : 'present')
const numbers: Record<string, number> = { present: 0 }
const zero = numbers.present
console.log(zero === undefined ? -1 : zero)
function optional(): Entry | undefined {
  return table.missing
}
console.log(optional() === undefined ? 'optional-missing' : 'unexpected')
const declared: { present: Single; [key: string]: Entry } = { present: new Single(42) }
const required = declared.present
console.log(required === undefined ? 'unexpected' : 'declared')
