// ECMA-262 23.1.3.16 includes compares with SameValueZero, which checks Types
// first -- so the search value need not share the element's carrier. A database
// client asks `Object.values(Enum).includes(value as any)` and
// `(string | undefined)[]`'s `.includes(name)`.

const modes: string[] = ['auto', 'poll', 'stream']
const check = (value: any): boolean => modes.includes(value)

//! expect: dyn-hit=true
console.log('dyn-hit=' + check('poll'))
//! expect: dyn-miss=false
console.log('dyn-miss=' + check('push'))
//! expect: dyn-type=false
console.log('dyn-type=' + check(1))

const counts: number[] = [1, 2, NaN]
const has = (value: any): boolean => counts.includes(value)
//! expect: num=true,false,true
console.log('num=' + has(2) + ',' + has('2') + ',' + has(NaN))

const names: (string | undefined)[] = ['a', undefined, 'c']
const find = (name: string): boolean => names.includes(name)
//! expect: optional=true,false
console.log('optional=' + find('c') + ',' + find('b'))
