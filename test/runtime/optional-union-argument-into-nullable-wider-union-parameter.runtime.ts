// The native-webgl-angle texture-upload rewrite passes `depthTexture.image`
// (an optional union of image shapes) to `requireTextureImageRecord( value )`,
// whose parameter is a WIDER union that also admits `null`: the argument's
// absent arm lands on the parameter's `undefined`, and its present union on
// the parameter's present union.
interface Pixels {
  data: Uint8Array
  width: number
  height: number
}
interface Canvas {
  width: number
  height: number
  complete: boolean
}
interface Record3 {
  data?: Uint8Array
  width?: number
  height?: number
  depth?: number
}
class Holder {
  image: Pixels | Canvas | undefined = undefined
}
const describe = (value: Pixels | Canvas | Record3 | null | undefined): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return `${value.width}x${value.height}`
}
const holder = new Holder()
console.log(describe(holder.image))
holder.image = { data: new Uint8Array(4), width: 2, height: 1 }
console.log(describe(holder.image))
holder.image = { width: 3, height: 5, complete: true }
console.log(describe(holder.image))
console.log(describe(null), describe({ depth: 1, width: 7, height: 8 }))

//! expect: undefined
//! expect: 2x1
//! expect: 3x5
//! expect: null 7x8
