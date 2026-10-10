// A binary-document serializer's parser-utility shape exactly: the captured accessor call sits in
// a module-level IIFE result that an EXPORTED predicate uses, and the
// predicate's callers compare its result against a string.
//! emitted-lacks: adaptSource
const TypedArrayPrototypeGetSymbolToStringTag = (() => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the intention is to call this method with a bound value
  const g = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!

  return (value: unknown) => g.call(value)
})()

export function isUint8Array(value: unknown): value is Uint8Array {
  return TypedArrayPrototypeGetSymbolToStringTag(value) === 'Uint8Array'
}

export function isAnyArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    typeof value === 'object' &&
    value != null &&
    Symbol.toStringTag in value &&
    (value[Symbol.toStringTag] === 'ArrayBuffer' || value[Symbol.toStringTag] === 'SharedArrayBuffer')
  )
}

const probe = (value: unknown): string => `${isUint8Array(value)}:${isAnyArrayBuffer(value)}`
console.log(probe(new Uint8Array(2)), probe(new Float64Array(1)), probe(new ArrayBuffer(4)), probe({}), probe(3))
//! expect: true:false false:false false:true false:false false:false
