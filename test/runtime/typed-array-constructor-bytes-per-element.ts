//! expect: 4 1 1 1 2 2 4 4 8
//! emitted-lacks: gea::Value::box
// `BYTES_PER_ELEMENT` read off the constructor rather than an instance, as
// three's `renderers/common/Buffer.js` does (`Float32Array.BYTES_PER_ELEMENT`).
// It is a constant of the type (ECMA-262 23.2.6.1, Table 71).
class AttributeBuffer {
  bytesPerElement: number
  constructor(readonly name: string) {
    this.bytesPerElement = Float32Array.BYTES_PER_ELEMENT
  }
}

console.log(
  new AttributeBuffer('positions').bytesPerElement,
  Int8Array.BYTES_PER_ELEMENT,
  Uint8Array.BYTES_PER_ELEMENT,
  Uint8ClampedArray.BYTES_PER_ELEMENT,
  Int16Array.BYTES_PER_ELEMENT,
  Uint16Array.BYTES_PER_ELEMENT,
  Int32Array.BYTES_PER_ELEMENT,
  Uint32Array.BYTES_PER_ELEMENT,
  Float64Array.BYTES_PER_ELEMENT
)
export {}
