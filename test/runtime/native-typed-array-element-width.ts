//! expect: 1 1 1 2 2 4 4 4 8
//! expect: 0 4 4
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

type NumericView =
  Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array

function elementWidth(view: NumericView): number {
  return view.BYTES_PER_ELEMENT
}

console.log(
  elementWidth(new Int8Array(1)),
  elementWidth(new Uint8Array(1)),
  elementWidth(new Uint8ClampedArray(1)),
  elementWidth(new Int16Array(1)),
  elementWidth(new Uint16Array(1)),
  elementWidth(new Int32Array(1)),
  elementWidth(new Uint32Array(1)),
  elementWidth(new Float32Array(1)),
  elementWidth(new Float64Array(1))
)

const empty = new Float32Array(new ArrayBuffer(16), 4, 0)
console.log(empty.length, empty.BYTES_PER_ELEMENT, elementWidth(empty))
