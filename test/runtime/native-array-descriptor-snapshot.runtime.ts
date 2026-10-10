//! expect: snapshot:true:2:9
//! expect: restored:3
const original: any = JSON.parse('[2]')
const values: number[] = original
const descriptor = Object.getOwnPropertyDescriptor(values, '0')
original[0] = 9
console.log(`snapshot:${descriptor?.enumerable}:${descriptor?.value}:${values[0]}`)

const secondOriginal: any = JSON.parse('[3]')
const second: number[] = secondOriginal
const captured = Object.getOwnPropertyDescriptor(second, '0')
secondOriginal[0] = 7
if (captured) Object.defineProperty(second, '0', captured)
console.log(`restored:${second[0]}`)
