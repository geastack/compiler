// A binary-document library's typed-array brand check: the getter of
// %TypedArray%.prototype[@@toStringTag], read off the intrinsic prototype and
// called with an arbitrary receiver.
const TypedArrayPrototypeGetSymbolToStringTag = (() => {
  const g = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!

  return (value: unknown) => g.call(value)
})()

function isUint8Array(value: unknown): value is Uint8Array {
  return TypedArrayPrototypeGetSymbolToStringTag(value) === 'Uint8Array'
}

//! expect: u8=Uint8Array
console.log('u8=' + TypedArrayPrototypeGetSymbolToStringTag(new Uint8Array(4)))
//! expect: f64=Float64Array
console.log('f64=' + TypedArrayPrototypeGetSymbolToStringTag(new Float64Array(2)))
//! expect: object=undefined
console.log('object=' + TypedArrayPrototypeGetSymbolToStringTag({ a: 1 }))
//! expect: string=undefined
console.log('string=' + TypedArrayPrototypeGetSymbolToStringTag('Uint8Array'))
//! expect: array=undefined
console.log('array=' + TypedArrayPrototypeGetSymbolToStringTag([1, 2, 3]))
//! expect: isUint8Array(u8)=true
console.log('isUint8Array(u8)=' + isUint8Array(new Uint8Array(1)))
//! expect: isUint8Array(i32)=false
console.log('isUint8Array(i32)=' + isUint8Array(new Int32Array(1)))
//! expect: isUint8Array(array)=false
console.log('isUint8Array(array)=' + isUint8Array([1]))
