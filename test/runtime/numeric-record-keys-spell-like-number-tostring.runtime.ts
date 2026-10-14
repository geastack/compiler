//! expect: keys=0,1,7,42,9007199254740991,-3,0.5,1e+21,NaN
//! expect: reads=a,b,c,d,e,f,g,h,i
//! expect: negzero=a,true
// A `Record<number, T>` stores ECMAScript property keys: each number spells as
// `Number::toString` would. Integral keys take a digits-only path; every other
// number -- fractions, beyond the safe range, NaN -- the general formatter, and
// -0 is "0" either way.

const table: Record<number, string> = {}
const keys = [0, 1, 7, 42, 9007199254740991, -3, 0.5, 1e21, NaN]
const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
keys.forEach((key, index) => {
  table[key] = names[index]!
})
console.log(`keys=${Object.keys(table).join(',')}`)
console.log(`reads=${keys.map((key) => table[key] ?? '-').join(',')}`)
console.log(`negzero=${table[-0] ?? '-'},${-0 in table}`)
