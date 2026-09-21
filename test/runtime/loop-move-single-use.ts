//! expect: outside prefix-0|prefix-1|prefix-2 kept=prefix-
//! expect: sameBlock a=1|b=2|c=3
//! expect: crossBlock A=1|b=2|C=3
//! expect: union text:x|7|text:y
//! expect: nested 0:r|0:r|1:r|1:r kept=r

// A single-use SSA value may be MOVED into its consumer, and a loop is where
// that goes wrong: a move inside a cyclic block is observed by the next trip
// unless the value is written again first.
//
// `ownedDyingValuesOf` used to refuse every use in a cyclic block outright,
// which copied a whole string or union per iteration of every `for`/`for-in`
// body. It now moves when (a) the value is defined and consumed in one block,
// or (b) no path re-enters the use without passing the definition. Each case
// below is one side of that decision:
//
//   outside     defined BEFORE the loop, sole use inside it. Must stay a copy:
//               a move empties it on trip one and trips two and three read "".
//   sameBlock   defined and consumed in the loop body's block -- moves.
//   crossBlock  defined in one block of the body, consumed after a branch in
//               another; every trip re-runs the definition -- moves.
//   union       the carrier is a tagged union with an owning (string) arm,
//               which `ownsItsStorage` now treats as owning.
//   nested      defined in the OUTER body, sole use in the INNER loop: the
//               inner back edge re-enters the use without redefining it, so
//               this must stay a copy.

const parts: string[] = []
const sink = (text: string): void => {
  parts.push(text)
}

const outside = (count: number): string => {
  const seen: string[] = []
  const prefix = 'prefix' + String.fromCharCode(45)
  for (let index = 0; index < count; index++) {
    const held: string[] = [prefix]
    seen.push((held[0] ?? '') + String(index))
  }
  return seen.join('|')
}
const keptPrefix = (): string => {
  const prefix = 'prefix' + String.fromCharCode(45)
  let last = ''
  for (let index = 0; index < 3; index++) {
    const holder: string[] = []
    holder.push(prefix)
    last = holder[0] ?? ''
  }
  return last
}
console.log('outside ' + outside(3) + ' kept=' + keptPrefix())

const table: Record<string, number> = { a: 1, b: 2, c: 3 }
for (const key in table) {
  const line = key + '=' + String(table[key])
  sink(line)
}
console.log('sameBlock ' + parts.join('|'))

parts.length = 0
for (const key in table) {
  const line = key + '=' + String(table[key])
  let shown: string
  if ((table[key] ?? 0) % 2 === 1) shown = line.toUpperCase()
  else shown = line
  sink(shown)
}
console.log('crossBlock ' + parts.join('|'))

const mixed: Record<string, string | number> = { first: 'x', second: 7, third: 'y' }
const rendered: string[] = []
for (const key in mixed) {
  const value: string | number = mixed[key] ?? 0
  const kept: (string | number)[] = []
  kept.push(value)
  const back = kept[0] ?? 0
  rendered.push(typeof back === 'string' ? 'text:' + back : String(back))
}
console.log('union ' + rendered.join('|'))

const nestedOut: string[] = []
let keptRow = ''
for (let outer = 0; outer < 2; outer++) {
  const row = String.fromCharCode(114)
  for (let inner = 0; inner < 2; inner++) {
    const cell: string[] = []
    cell.push(row)
    nestedOut.push(String(outer) + ':' + (cell[0] ?? ''))
    keptRow = cell[0] ?? ''
  }
}
console.log('nested ' + nestedOut.join('|') + ' kept=' + keptRow)
