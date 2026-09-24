// A typed-array spread into NAMED formals. `%TypedArray%.prototype[@@iterator]`
// is the view's index reads in order, the same as an Array's, so each formal
// reads its own index: `undefined` past the end, extra values dropped. Every
// line below is checked against node's own output.

function rgb(r?: number, g?: number, b = 1): string {
  return `${r}:${g}:${b}`
}

const color = new Float32Array([0.5, 0.25, 0.125])
const pair = new Uint8Array([7, 8])
const wide = new Int32Array([1, 2, 3, 4, 5])
const empty = new Float64Array(0)

//! expect: typed=0.5:0.25:0.125 7:8:1 1:2:3 undefined:undefined:1 9:7:8
console.log(`typed=${rgb(...color)} ${rgb(...pair)} ${rgb(...wide)} ${rgb(...empty)} ${rgb(9, ...pair)}`)

class Vec2 {
  x: number
  y: number
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }
}
const v = new Vec2(...pair)
//! expect: vec2=7,8
console.log(`vec2=${v.x},${v.y}`)
