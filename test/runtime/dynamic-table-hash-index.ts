//! expect: plain 40 k0,k1,k2,k39 | 7 undefined 39
//! expect: redefined 0,1,2,3,38,39 | 100 true
//! expect: readded k2,k4,k3 | 3 40
//! expect: native 40 true 17 undefined 39
//! expect: symbol s1 s2 true
// A property table keeps a hash index once it holds 16 entries (three.js puts
// ~3,400 on `Node.prototype`). The index is only a cache of positions: a
// delete shifts them and a re-add appends, so creation order, lookups after
// a delete, and symbol keys must answer exactly as the linear table did.
const plain: any = {}
for (let i = 0; i < 40; i++) plain['k' + i] = i
const keys = Object.keys(plain)
console.log('plain', keys.length, [keys[0], keys[1], keys[2], keys[39]].join(','), '|', plain.k7, plain.k40, plain.k39)
delete plain.k3
plain.k3 = 3
const readded = Object.keys(plain)
console.log('readded', [readded[2], readded[3], readded[39]].join(','), '|', plain.k3, readded.length)

const small: any = {}
for (let i = 0; i < 40; i++) small[String(i)] = i
delete small['1']
delete small['4']
small['1'] = 100
for (let i = 4; i < 38; i++) delete small[String(i)]
console.log('redefined', Object.keys(small).join(','), '|', small['1'], small['2'] === 2)

class Holder {
  x = 1
}
const held: any = new Holder()
for (let i = 0; i < 40; i++) held['e' + i] = i
delete held.e18
console.log('native', Object.keys(held).length, held.e0 === 0, held.e17, held.e18, held.e39)

const s1 = Symbol('s1')
const s2 = Symbol('s2')
const withSymbols: any = {}
for (let i = 0; i < 20; i++) withSymbols['p' + i] = i
withSymbols[s1] = 's1'
withSymbols[s2] = 's2'
console.log('symbol', withSymbols[s1], withSymbols[s2], withSymbols.p19 === 19)
