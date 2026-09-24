//! expect: typed b,a | b=1;a=2 | {"b":1,"a":2} | b,a
//! expect: late-before b | {"b":1} | false
//! expect: late-after b,a | {"b":1,"a":5} | true
//! expect: mixed b,x,a,y | {"b":1,"x":2,"a":3,"y":4} | b,x,a,y
//! expect: readd b,x,y,a | {"b":1,"x":5,"y":4,"a":6}
//! expect: ints 1,7,b,a | {"1":2,"7":4,"b":1,"a":3}
//! expect: class z,w,x | x,z | z,x | z=3;w=8;x=1
//! expect: untouched p,q | {"p":1,"q":2}
// ECMA-262 10.1.11.1 enumerates string keys in CREATION order. A typed
// literal's struct lists its fields in the TYPE's declaration order, and an
// optional field's bit said nothing about when it was set, so every line but
// the last printed the declaration order: `a,b` for `{ b, a }`, `a` before
// `b` once the optional `a` was set late, a deleted-then-re-added key back in
// its declared slot, and index-signature keys after every declared field.
// `untouched` is the control: its literal writes its keys in layout order and
// nothing adds one later, so it keeps the untracked layout.
const s = (text: string): string => text + ''
const entries = (o: object): string =>
  Object.entries(o)
    .map(([k, v]) => k + '=' + v)
    .join(';')

interface Pair {
  a: number
  b: number
}
const typed: Pair = { b: 1, a: 2 }
console.log(
  'typed',
  Object.keys(typed).join(','),
  '|',
  entries(typed),
  '|',
  JSON.stringify(typed),
  '|',
  Object.getOwnPropertyNames(typed).join(',')
)

interface Late {
  a?: number
  b: number
}
const late: Late = { b: 1 }
console.log('late-before', Object.keys(late).join(','), '|', JSON.stringify(late), '|', 'a' in late)
late.a = 5
console.log('late-after', Object.keys(late).join(','), '|', JSON.stringify(late), '|', 'a' in late)

interface Mixed {
  a?: number
  b: number
  [key: string]: number | undefined
}
const mixed: Mixed = { b: 1 }
mixed[s('x')] = 2
mixed.a = 3
mixed[s('y')] = 4
console.log('mixed', Object.keys(mixed).join(','), '|', JSON.stringify(mixed), '|', Object.getOwnPropertyNames(mixed).join(','))
mixed[s('x')] = 5
delete mixed.a
mixed.a = 6
console.log('readd', Object.keys(mixed).join(','), '|', JSON.stringify(mixed))

interface Numbered {
  a?: number
  b: number
  [key: string]: number | undefined
}
const numbered: Numbered = { b: 1 }
numbered[s('7')] = 4
numbered.a = 3
numbered[s('1')] = 2
console.log('ints', Object.keys(numbered).join(','), '|', JSON.stringify(numbered))

class Base {
  x = 1
}
class Derived extends Base {
  z = 3
}
const derived = new Derived()
;(derived as unknown as Record<string, number>)[s('w')] = 8
const before = Object.keys(derived).filter((key) => key !== 'w')
delete (derived as { x?: number }).x
;(derived as { x?: number }).x = 1
console.log(
  'class',
  Object.keys(derived).join(','),
  '|',
  before.join(','),
  '|',
  Object.getOwnPropertyNames(derived)
    .filter((key) => key !== 'w')
    .join(','),
  '|',
  entries(derived)
)

const untouched = { p: 1, q: 2 }
console.log('untouched', Object.keys(untouched).join(','), '|', JSON.stringify(untouched))
