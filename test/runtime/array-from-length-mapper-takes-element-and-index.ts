// ECMA-262 23.1.2.1 Array.from: an array-like source's mapfn is called with
// (kValue, k), and for `{ length }` every kValue is `undefined`. The mapper's
// first parameter is then `unknown`, carried as `gea::Value`, while the runtime
// holds `Undefined`; a wider parameter over an array or string source is the
// same boundary. A three.js scene builds its tile grid and flock records this way.

//! expect: cells=[[0,0],[512,0],[0,512],[512,512]]
const cells: number[][] = [...Array.from({ length: 4 }, (_, i) => [(i % 2) * 512, Math.floor(i / 2) * 512])]
console.log('cells=' + JSON.stringify(cells))

const FLOCKS = 3
const flocks = Array.from({ length: FLOCKS }, (_, i) => ({ t0: -1, end: i * 9 }))
//! expect: flocks=-1:0,-1:9,-1:18
console.log('flocks=' + flocks.map((flock) => `${flock.t0}:${flock.end}`).join(','))

//! expect: kinds=undefined0,undefined1
console.log('kinds=' + Array.from({ length: 2 }, (value, i) => `${typeof value}${i}`).join(','))

//! expect: array=number0,number1,number2
console.log('array=' + Array.from([1, 2, 3], (value: unknown, i) => `${typeof value}${i}`).join(','))

//! expect: string=string0,string1
console.log('string=' + Array.from('ab', (value: unknown, i) => `${typeof value}${i}`).join(','))
