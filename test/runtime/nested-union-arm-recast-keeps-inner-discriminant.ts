// The runtime `Request` constructor: a body slot holding
// `undefined | null | (string | Uint8Array | ArrayBuffer | Sink)` is tested
// with a chain of guards, and after `typeof === 'string'` fails the read is
// the union the guards left. That read recasts the stored sum, whose present
// arm is ITSELF a sum: the inner discriminant must decide the target arm. A
// recast that took the inner sum's first member for every inner arm answered
// `isView` true for a Sink and read `.buffer` out of it.
class Sink {
  readonly label = 'sink'
}
type BodyValue = string | Uint8Array | ArrayBuffer | Sink
interface Init {
  body?: BodyValue | null
}
const describe = (init: Init): string => {
  if (typeof init.body === 'string') return `string:${init.body}`
  if (init.body !== undefined && init.body !== null && ArrayBuffer.isView(init.body)) {
    return `view:${init.body.byteOffset}+${init.body.byteLength}`
  }
  if (init.body instanceof Sink) return `sink:${init.body.label}`
  if (init.body instanceof ArrayBuffer) return `buffer:${init.body.byteLength}`
  return 'none'
}
console.log(describe({ body: 'hello' }))
console.log(describe({ body: new Uint8Array(new ArrayBuffer(8), 2, 4) }))
console.log(describe({ body: new Sink() }))
console.log(describe({ body: new ArrayBuffer(3) }))
console.log(describe({ body: null }))
console.log(describe({}))
//! expect: string:hello
//! expect: view:2+4
//! expect: sink:sink
//! expect: buffer:3
//! expect: none
//! expect: none
