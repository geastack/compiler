// A closed tuple is stored as a positional struct, but it IS an Array exotic
// object. Erased into `any`, it has to keep answering `Array.isArray`,
// `length` and its indexed elements -- a database client's `formatSort` dispatches a
// `readonly [string, SortDirection]` through `isReadonlyArray(value: any)`,
// and a `false` there sent the tuple down the Map arm.
function isArrayLike(value: any): boolean {
  return Array.isArray(value)
}
function describe(value: any): string {
  return `${value.length}:${value[0]}:${value[1]}:${value[2]}`
}
const pair: readonly [string, number] = ['a', -1]
const optional: [string, number?] = ['b']
console.log(isArrayLike(pair), isArrayLike({ 0: 'a', 1: -1 }))
console.log(describe(pair))
console.log(describe(optional))
const joined = (value: any): string => value.join('|')
console.log(joined(pair))

//! expect: true false
//! expect: 2:a:-1:undefined
//! expect: 1:b:undefined:undefined
//! expect: a|-1
