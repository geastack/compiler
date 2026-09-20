//! expect: 7
const boxed: unknown = 7
const back = boxed as number
console.log(String(back))
