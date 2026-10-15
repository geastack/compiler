// node-compat's `Request` reads `init.body.type` under `init.body instanceof
// Blob`, after a call that may write `init.body`: the read is off the whole
// `BodyInit` union again, one arm of which is a record that is a live view of
// a Document. That arm declares no `type`, so the per-arm union read reaches
// it through the native [[Get]], which asks the view's Document first -- no
// view slot is read and no field-view receipt is needed. The call here really
// does swap the body for the view, and the read answers the Document's entry.
export {}

interface ByteView {
  buffer: ArrayBuffer
  byteOffset: number
  byteLength: number
}

class Blob {
  readonly type: string
  size(): number {
    return this.type.length
  }
  constructor(type: string) {
    this.type = type
  }
}

class Params {
  toString(): string {
    return 'a=1'
  }
}

type Body = string | Uint8Array | ByteView | Blob | Params

interface Init {
  method?: string
  body?: Body | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamic: any = JSON.parse('{"byteOffset": 1, "byteLength": 3, "type": "doc/view"}')
dynamic.buffer = new ArrayBuffer(5)
const viewed: ByteView = dynamic

const measure = (init: Init, size: number): number => {
  if (size > 20) init.body = viewed
  return size
}

const describe = (init: Init): string => {
  if (typeof init.body === 'string') return 'text:' + init.body
  if (init.body instanceof Params) return 'params:' + init.body.toString()
  if (init.body instanceof Blob) {
    const size = measure(init, init.body.size())
    return 'blob:' + size + ':' + init.body.type
  }
  if (init.body !== undefined && init.body !== null) return 'bytes:' + init.body.byteLength
  return 'none'
}

console.log(describe({ method: 'POST', body: new Blob('text/plain') }))
console.log(describe({ body: new Blob('application/x-long-media-type') }))
console.log(describe({ body: 'hello' }))
console.log(describe({ body: new Uint8Array(4) }))
console.log(describe({ body: viewed }))
console.log(describe({ body: new Params() }))
console.log(describe({}))
//! expect: blob:10:text/plain
//! expect: blob:29:doc/view
//! expect: text:hello
//! expect: bytes:4
//! expect: bytes:3
//! expect: params:a=1
//! expect: none
