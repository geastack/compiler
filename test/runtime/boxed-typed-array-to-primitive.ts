//! expect: bytes 1,2,250|len=7
//! expect: floats 0.5,-2|template=0.5,-2
//! expect: empty []
//! expect: number NaN|7
//! expect: own length=3|byteLength=16|byteOffset=0|first=1|last=250|past=undefined

// ToPrimitive of a typed array the program holds only as `unknown`/`any`.
//
// A typed array is a native carrier with no dynamic property surface, so the
// generic ToPrimitive -- read `@@toPrimitive` off the box, then `valueOf`, then
// `toString` -- had nothing to read and aborted by name on the first `[[Get]]`.
// node-compat's `'data'` listeners are what reached it: Node types the chunk
// `any` and hands out a Buffer, so `body + chunk` is this operation.
//
// 7.1.1 has one answer for every typed array and every hint, because nothing a
// program can do installs `@@toPrimitive` or a non-Object `valueOf` on one:
// `%TypedArray%.prototype.toString`, the comma-joined elements (23.2.3.32).
// `number` pins the Number hint arriving at the same string and then at
// ToNumber of it.

const opaque = (value: unknown): unknown => value

const bytes: unknown = opaque(new Uint8Array([1, 2, 250]))
const joined = '' + bytes
console.log('bytes ' + joined + '|len=' + String(joined.length))

const floats: unknown = opaque(new Float64Array([0.5, -2]))
console.log('floats ' + String(floats) + '|template=' + `${floats}`)

const none: unknown = opaque(new Int16Array(0))
console.log('empty [' + String(none) + ']')

const one: unknown = opaque(new Uint8Array([7]))
console.log('number ' + String(Number(bytes)) + '|' + String(Number(one)))

// The own surface a byte-counting handler reads off the same erased view:
// `length`, `byteLength`, `byteOffset` and an indexed element, with an index
// past the end reading `undefined` (10.4.5.15) rather than a prototype value.
// `any`, not an `as` to a record type: the cast would ask the box to BE that
// record, and what is under test is a property read off the box as it stands.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const view: any = bytes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wide: any = floats
console.log(
  'own length=' +
    String(view.length) +
    '|byteLength=' +
    String(wide.byteLength) +
    '|byteOffset=' +
    String(wide.byteOffset) +
    '|first=' +
    String(view[0]) +
    '|last=' +
    String(view[2]) +
    '|past=' +
    String(view[3])
)
