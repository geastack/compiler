// `in` and a prototype read on a boxed TypedArray, ArrayBuffer, SharedArrayBuffer
// and DataView. A byte block reaches a box wherever a library types it
// `unknown`; a binary-document serializer's `isAnyArrayBuffer` then asks `Symbol.toStringTag in value`
// of it and reads the tag back. The runtime holds no property table for these
// -- their surface is the closed prototype chain the spec states (23.2.3,
// 25.1.6, 25.2.5, 25.3.4) plus in-range integer indices -- so both answers
// come from the box's brand, and a key the chain does not hold is simply
// absent instead of a refusal. The probes take `any` so every block crosses
// as a box: a tagged-union parameter would be the compiler's own `in`, not the
// runtime's.
const isAnyArrayBuffer = (value: any): boolean =>
  typeof value === 'object' &&
  value != null &&
  Symbol.toStringTag in value &&
  (value[Symbol.toStringTag] === 'ArrayBuffer' || value[Symbol.toStringTag] === 'SharedArrayBuffer')
const has = (value: any, key: string): boolean => typeof value === 'object' && value != null && key in value
const bytes = new Uint8Array([7, 8, 9])
const buffer = new ArrayBuffer(4)
const shared = new SharedArrayBuffer(2)
const view = new DataView(buffer)
console.log(isAnyArrayBuffer(bytes), isAnyArrayBuffer(buffer), isAnyArrayBuffer(shared), isAnyArrayBuffer(view), isAnyArrayBuffer({}))
//! expect: false true true false false
console.log(
  has(bytes, '2'),
  has(bytes, '3'),
  has(bytes, 'length'),
  has(bytes, 'subarray'),
  has(bytes, 'nope'),
  has(bytes, 'hasOwnProperty')
)
//! expect: true false true true false true
console.log(
  has(buffer, 'byteLength'),
  has(buffer, 'slice'),
  has(buffer, 'grow'),
  has(shared, 'grow'),
  has(view, 'getUint8'),
  has(view, 'slice')
)
//! expect: true true false true true false
const tagOf = (value: unknown): unknown =>
  typeof value === 'object' && value != null ? (value as Record<symbol, unknown>)[Symbol.toStringTag] : null
console.log(tagOf(bytes), tagOf(buffer), tagOf(shared), tagOf(view), (bytes as any).BYTES_PER_ELEMENT)
//! expect: Uint8Array ArrayBuffer SharedArrayBuffer DataView 1
export {}
