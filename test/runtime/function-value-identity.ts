//! same:true
//! copied:true
//! separate:false
//! adapted:true

const original = (value: number): number => value + 1
const copied = original
const separate = (value: number): number => value + 1
const adapted: (value: number, ignored?: string) => number = original

console.log(`same:${original === original}`)
console.log(`copied:${original === copied}`)
console.log(`separate:${original === separate}`)
console.log(`adapted:${adapted === original}`)
