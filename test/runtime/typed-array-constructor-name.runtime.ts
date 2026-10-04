// `array.constructor.name` off a typed array (three's `BufferAttribute.toJSON`,
// `type: this.array.constructor.name`): the [[TypedArrayName]] of the class
// that allocated the array, for one typed array and per arm of a union of them.

type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array

class Attribute {
  array: TypedArray
  constructor(array: TypedArray) {
    this.array = array
  }
  toJSON(): { type: string; length: number } {
    return { type: this.array.constructor.name, length: this.array.length }
  }
}

function single(array: Float32Array): string {
  return array.constructor.name
}

const arrays: TypedArray[] = [
  new Int8Array(1),
  new Uint8Array(2),
  new Uint8ClampedArray(3),
  new Int16Array(4),
  new Uint16Array(5),
  new Int32Array(6),
  new Uint32Array(7),
  new Float32Array(8),
  new Float64Array(9)
]
console.log(single(new Float32Array(2)))
console.log(arrays.map((array) => new Attribute(array).toJSON().type).join(' '))
const json = new Attribute(new Uint16Array(3)).toJSON()
console.log(json.type, json.length)

//! expect: Float32Array
//! expect: Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array
//! expect: Uint16Array 3
