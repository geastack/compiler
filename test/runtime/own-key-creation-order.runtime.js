// @ts-nocheck
//! dynamic-fallback
//! expect: class-before b,a false false
//! expect: class-after b,a,dyn,lazy | b,a,dyn,lazy | b=1;a=2;dyn=4;lazy=3 | true
//! expect: plain-before  false
//! expect: plain-after c,a,b | c=1;a=2;b=3 | {"c":1,"a":2,"b":3} | true
//! expect: readd a,dyn,lazy,b | a=2;dyn=4;lazy=3;b=9 | false true
//! expect: ints 1,7,z,y | {"1":2,"7":4,"z":1,"y":3}
// ECMA-262 10.1.11.1: string keys enumerate in CREATION order, and a key a
// JavaScript class creates by `this.x =` exists only once that store runs.
// The generated struct declares every inferred member up front, in layout
// order, so each of these printed its layout instead: `lazy` before `dyn`,
// `'lazy' in n` true before `touch()` ran, `{}`'s `a,b` before the computed
// `c`, and a deleted-then-re-added key back in its declared slot.
const s = (text) => text + ''

class Base {
  constructor() {
    this.b = 1
  }
}
class Derived extends Base {
  constructor() {
    super()
    this.a = 2
  }
  touch() {
    this.lazy = 3
  }
}
const n = new Derived()
console.log('class-before', Object.getOwnPropertyNames(n).join(','), 'lazy' in n, Object.hasOwn(n, 'lazy'))
n[s('dyn')] = 4
n.touch()
console.log(
  'class-after',
  [
    Object.getOwnPropertyNames(n).join(','),
    Object.keys(n).join(','),
    Object.entries(n)
      .map(([k, v]) => k + '=' + v)
      .join(';'),
    'lazy' in n
  ].join(' | ')
)

const o = {}
console.log('plain-before', Object.keys(o).join(','), 'a' in o)
o[s('c')] = 1
o.a = 2
o.b = 3
console.log(
  'plain-after',
  [
    Object.keys(o).join(','),
    Object.entries(o)
      .map(([k, v]) => k + '=' + v)
      .join(';'),
    JSON.stringify(o),
    'a' in o
  ].join(' | ')
)

delete n.b
const gone = 'b' in n
n.b = 9
console.log(
  'readd',
  Object.keys(n).join(','),
  '|',
  Object.entries(n)
    .map(([k, v]) => k + '=' + v)
    .join(';'),
  '|',
  gone,
  'b' in n
)

const i = {}
i.z = 1
i[s('7')] = 4
i.y = 3
i[s('1')] = 2
console.log('ints', Object.keys(i).join(','), '|', JSON.stringify(i))
