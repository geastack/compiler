//! expect: log undefined
//! expect: param unknown undefined string
//! expect: param any undefined string
//! expect: decl unknown undefined
//! expect: as unknown undefined undefined
//! expect: as unknown and undefined x
//! expect: as any and undefined x
//! expect: as unknown or f x
//! expect: local log undefined x
//! expect: local param unknown undefined string
//! expect: local decl unknown undefined
//! expect: local as unknown and undefined x
interface StringMap {
  [name: string]: string
}
const plain: StringMap = { a: 'x' }
function show(value: unknown): string {
  return typeof value
}
function loose(value: any): string {
  return typeof value
}
console.log('log', plain['b'])
console.log('param unknown', show(plain['b']), show(plain['a']))
console.log('param any', loose(plain['b']), loose(plain['a']))
const held: unknown = plain['b']
console.log('decl unknown', typeof held)
const asserted = plain['b'] as unknown
console.log('as unknown', typeof asserted, asserted)
console.log('as unknown and', (plain['b'] as unknown) && 'x', (plain['a'] as unknown) && 'x')
console.log('as any and', (plain['b'] as any) && 'x', (plain['a'] as any) && 'x')
console.log('as unknown or', (plain['b'] as unknown) || 'f', (plain['a'] as unknown) || 'f')
let local: string | undefined = plain['b']
let localPresent: string | undefined = plain['a']
console.log('local log', local, localPresent)
console.log('local param unknown', show(local), show(localPresent))
const localHeld: unknown = local
console.log('local decl unknown', typeof localHeld)
console.log('local as unknown and', (local as unknown) && 'x', (localPresent as unknown) && 'x')
