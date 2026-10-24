//! expect: asserted and x 1
//! expect: asserted or x x
//! expect: asserted nullish x
//! expect: asserted condition x
//! expect: asserted local and x 1
//! expect: asserted local or x
interface StringMap {
  [name: string]: string | number
}
const plain: StringMap = { a: 'x' }
let local: string | number | undefined = plain['a']
console.log('asserted and', (plain['a'] as string) && 'x', (plain['a'] as string) && (plain['a'] as string).length)
console.log('asserted or', (plain['a'] as string) || 'f', (local as string) || 'f')
console.log('asserted nullish', (plain['a'] as string) ?? 'f')
console.log('asserted condition', plain['a'] ? (plain['a'] as string) : 'f')
console.log('asserted local and', (local as string) && 'x', (local as string) && (local as string).length)
console.log('asserted local or', (local as string) || 'f')
