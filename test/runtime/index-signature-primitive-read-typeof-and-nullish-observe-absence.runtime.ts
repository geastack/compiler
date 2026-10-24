//! expect: direct typeof undefined string
//! expect: dotted typeof undefined string
//! expect: named typeof undefined string
//! expect: annotated typeof undefined string
//! expect: typeof is undefined true false
//! expect: direct nullish fallback x
//! expect: dotted nullish fallback x
//! expect: named nullish fallback x
//! expect: number nullish 7 1
//! expect: direct or or x
//! expect: array typeof undefined number
//! expect: array typeof is undefined true false
interface StringMap {
  [name: string]: string
}
interface NumberMap {
  [name: string]: number
}
const plain: StringMap = { a: 'x' }
const numbers: NumberMap = { a: 1 }
const list: number[] = [1]
const named = plain['b']
const present = plain['a']
let annotated: string | undefined = plain['b']
let annotatedPresent: string | undefined = plain['a']
console.log('direct typeof', typeof plain['b'], typeof plain['a'])
console.log('dotted typeof', typeof plain.b, typeof plain.a)
console.log('named typeof', typeof named, typeof present)
console.log('annotated typeof', typeof annotated, typeof annotatedPresent)
console.log('typeof is undefined', typeof plain['b'] === 'undefined', typeof plain['a'] === 'undefined')
console.log('direct nullish', plain['b'] ?? 'fallback', plain['a'] ?? 'fallback')
console.log('dotted nullish', plain.b ?? 'fallback', plain.a ?? 'fallback')
console.log('named nullish', named ?? 'fallback', present ?? 'fallback')
console.log('number nullish', numbers['b'] ?? 7, numbers['a'] ?? 7)
console.log('direct or', plain['b'] || 'or', plain['a'] || 'or')
console.log('array typeof', typeof list[5], typeof list[0])
console.log('array typeof is undefined', typeof list[5] === 'undefined', typeof list[0] === 'undefined')
