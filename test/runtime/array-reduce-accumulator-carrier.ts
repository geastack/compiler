//! expect: rest 1.75 6 0
//! expect: literal 0.75 0.75 -0.5
//! expect: fixed 10.5 x:1.5
//! expect: objects 3.5 a|b
//! expect: right 0.125 cba
// `reduce`'s accumulator is the callback's first parameter, not whatever C++
// type the initial value's literal spells: `xs.reduce((a, b) => a + b, 0)`
// deduced the accumulator as `int` from `(0)` and truncated every partial sum,
// so `sum(0.5, 0.25, 1)` printed 1.
function sum(...xs: number[]) {
  return xs.reduce((a, b) => a + b, 0)
}
console.log('rest', sum(0.5, 0.25, 1), sum(1, 2, 3), sum())

const halves = [0.5, 0.25]
console.log(
  'literal',
  halves.reduce((a, b) => a + b, 0),
  halves.reduce((a, b) => a + b),
  [0.5, -1].reduce((a, b) => a + b, 0)
)

function scaled(factor: number, ...xs: number[]) {
  return xs.reduce((a, b) => a + b * factor, 0)
}
function tagged(label: string, ...xs: number[]) {
  return xs.reduce((a, b) => a + b, label + ':')
}
console.log('fixed', scaled(1.5, 3, 4), tagged('x', 1.5))

interface Item {
  name: string
  weight: number
}
function total(...items: Item[]) {
  return items.reduce((a, item) => a + item.weight, 0)
}
function names(...items: Item[]) {
  return items.reduce((a, item) => (a === '' ? item.name : a + '|' + item.name), '')
}
const a: Item = { name: 'a', weight: 1.25 }
const b: Item = { name: 'b', weight: 2.25 }
console.log('objects', total(a, b), names(a, b))

console.log(
  'right',
  [0.5, 0.25].reduceRight((acc, x) => acc * x, 1),
  ['a', 'b', 'c'].reduceRight((acc, x) => acc + x, '')
)
