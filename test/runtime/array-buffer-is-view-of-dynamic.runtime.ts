// `ArrayBuffer.isView` of an `any` -- a binary-document serializer's
// `calculateElementSize(name, value:
// any, ...)` sizes a binary element when `ArrayBuffer.isView(value)`. The box
// carries its payload's exact type, which is the [[ViewedArrayBuffer]] test.
function sized(value: any): string {
  return ArrayBuffer.isView(value) ? 'view' : 'other'
}
const a: any = new Uint8Array(3)
const b: any = new Float64Array(2)
const c: any = new Int16Array(1)
console.log([sized(a), sized(b), sized(c)].join(','))
//! expect: view,view,view
const d: any = new ArrayBuffer(4)
const e: any = 'text'
const f: any = 7
const g: any = null
const h: any = undefined
const k: any = { byteLength: 1 }
console.log([sized(d), sized(e), sized(f), sized(g), sized(h), sized(k)].join(','))
//! expect: other,other,other,other,other,other

// The serializer's own shape: the size read happens off the `any` itself, after a
// disjunction of guards -- the box's own property protocol answers it.
function binarySize(value: any): number {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return 6 + value.byteLength
  return -1
}
console.log(binarySize(a), binarySize(b), binarySize(d), binarySize(e))
//! expect: 9 22 10 -1

// A view read back out at the identity the program asserts: the box's payload
// is the exact typed array, so the assertion admits it.
function firstByte(value: any): number {
  if (ArrayBuffer.isView(value)) return (value as Uint8Array)[0]! + (value as Uint8Array).byteLength
  return -1
}
const bytes = new Uint8Array(3)
bytes[0] = 40
const wide: any = new Int32Array(2)
console.log(firstByte(bytes), binarySize(wide), wide.byteLength)
//! expect: 43 14 8
