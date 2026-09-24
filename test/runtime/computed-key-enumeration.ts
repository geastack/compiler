//! expect: record alpha,gamma | 1,3 | alpha=1;gamma=3 | {"alpha":1,"gamma":3} | alpha,gamma
//! expect: dict 2,10,p,q | 4,2,3,5 | 2=4;10=2;p=3;q=5 | {"2":4,"10":2,"p":3,"q":5} | 2,10,p,q
//! expect: index b,x,y | 1,2,4 | b=1;x=2;y=4 | {"b":1,"x":2,"y":4} | b,x,y
//! expect: index-ints 1,3,b,x | 5,6,1,2 | {"1":5,"3":6,"b":1,"x":2}
// Computed-key writes in typed TypeScript: a `Record<string, number>` and a
// declared shape with an index signature, whose computed keys live in the
// record's index sidecar. Deleting a key and writing it again moves it to the
// end: OrdinaryOwnPropertyKeys orders strings by creation, and a deleted key
// is created anew. `Object.values`, `Object.entries` and `JSON.stringify` of
// the index-signature record walked its declared field alone and printed
// `1`, `b=1` and `{"b":1}`.
const s = (text: string): string => text + ''
const r: Record<string, number> = { alpha: 1 }
r[s('gamma')] = 3
console.log(
  'record',
  [
    Object.keys(r).join(','),
    Object.values(r).join(','),
    Object.entries(r)
      .map(([k, v]) => k + '=' + v)
      .join(';'),
    JSON.stringify(r),
    Object.getOwnPropertyNames(r).join(',')
  ].join(' | ')
)

const d: Record<string, number> = { q: 1 }
d[s('10')] = 2
d[s('p')] = 3
d[s('2')] = 4
delete d[s('q')]
d[s('q')] = 5
const dIn: string[] = []
for (const k in d) dIn.push(k)
console.log(
  'dict',
  [
    Object.keys(d).join(','),
    Object.values(d).join(','),
    Object.entries(d)
      .map(([k, v]) => k + '=' + v)
      .join(';'),
    JSON.stringify(d),
    dIn.join(',')
  ].join(' | ')
)

interface Indexed {
  b: number
  [k: string]: number
}
const x: Indexed = { b: 1 }
x[s('x')] = 2
x[s('y')] = 4
const xIn: string[] = []
for (const k in x) xIn.push(k)
console.log(
  'index',
  [
    Object.keys(x).join(','),
    Object.values(x).join(','),
    Object.entries(x)
      .map(([k, v]) => k + '=' + v)
      .join(';'),
    JSON.stringify(x),
    xIn.join(',')
  ].join(' | ')
)

const y: Indexed = { b: 1 }
y[s('x')] = 2
y[s('3')] = 6
y[s('1')] = 5
console.log('index-ints', [Object.keys(y).join(','), Object.values(y).join(','), JSON.stringify(y)].join(' | '))
