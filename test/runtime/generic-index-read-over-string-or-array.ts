// `T[number]` for a `T` bound to `string` is `string`: a string normalizer's
// `first = <T extends string | any[]>(x: T): T[number] => x[0]` reads a code
// unit off the normalized input, and its copy at `T = string` must carry the
// read as a string rather than the dynamic box the open constraint suggests.

const first = <T extends string | any[]>(x: T): T[number] => x[0]
const last = <T extends string | any[]>(x: T): T[number] => x[x.length - 1]
const codePoint = (character: string) => character.codePointAt(0)

const input = 'abc'
//! expect: first=97 last=99
console.log('first=' + codePoint(first(input))! + ' last=' + codePoint(last(input))!)

const numbers: number[] = [4, 5, 6]
//! expect: numbers=4,6
console.log('numbers=' + first(numbers) + ',' + last(numbers))
