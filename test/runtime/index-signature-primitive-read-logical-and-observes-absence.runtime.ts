//! expect: named and undefined x
//! expect: named and length undefined 1
//! expect: direct and undefined x
//! expect: dotted and undefined x
//! expect: number and undefined 1
//! expect: array and undefined 1
//! expect: named and in condition absent present
//! expect: annotated and undefined x
//! expect: annotated condition absent present
//! expect: annotated or f x
//! expect: annotated nullish f x
//! expect: annotated not true false
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
console.log('named and', named && 'x', present && 'x')
console.log('named and length', named && named.length, present && present.length)
console.log('direct and', plain['b'] && 'x', plain['a'] && 'x')
console.log('dotted and', plain.b && 'x', plain.a && 'x')
console.log('number and', numbers['b'] && 1, numbers['a'] && 1)
console.log('array and', list[5] && 1, list[0] && 1)
console.log(
  'named and in condition',
  named && named.length > 0 ? 'present' : 'absent',
  present && present.length > 0 ? 'present' : 'absent'
)
console.log('annotated and', annotated && 'x', annotatedPresent && 'x')
console.log('annotated condition', annotated ? 'present' : 'absent', annotatedPresent ? 'present' : 'absent')
console.log('annotated or', annotated || 'f', annotatedPresent || 'f')
console.log('annotated nullish', annotated ?? 'f', annotatedPresent ?? 'f')
console.log('annotated not', !annotated, !annotatedPresent)
