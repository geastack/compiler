// A CALL THROUGH A BASE ANNOTATION WHOSE SUBCLASS OVERRIDE NARROWS `unknown`.
//
// `@hono/node-server`'s `listener.ts` writes `(outgoing as Writable).write(value)`
// over a value that really is node-compat's `ServerResponse`. Our `node:stream`
// declares `Writable.write(chunk: unknown, encodingOrCallback?: unknown,
// callback?: unknown)`, and `ServerResponse` overrides it as
// `write(chunk: string | Uint8Array): boolean` -- method parameters are
// bivariant, so the checker accepts the narrowing.
//
// The two signatures are two different ABIs, and the call must commit to ONE:
// either the virtual member on the base (three `Value`s, with the override's
// adapter unboxing arm by arm) or a devirtualized call on the override (one
// union argument). The emitted unit committed to neither -- it named the
// override's body while building the base's three-argument list -- and clang
// rejected the call outright.

class Sink {
  readonly written: string[]

  constructor() {
    this.written = []
  }

  write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
    void encodingOrCallback
    void callback
    this.written.push('base:' + String(chunk))
    return true
  }
}

class ByteSink extends Sink {
  override write(chunk: string | Uint8Array): boolean {
    this.written.push(typeof chunk === 'string' ? 'text:' + chunk : 'bytes:' + chunk.length)
    return true
  }
}

const sink = new ByteSink()
const bytes = new Uint8Array(3)

// Through an `as` cast inside a closure that CAPTURES the receiver at its own
// (subclass) type -- `listener.ts`'s exact shape, `values.forEach((value) => {
// ;(outgoing as Writable).write(value) })`. The cast is the only thing that
// widens, and it widens at the call and nowhere else.
const chunks: Uint8Array[] = [bytes]
chunks.forEach((value) => {
  ;(sink as Sink).write(value)
})
;(sink as Sink).write('hi')

// Through the subclass's own annotation, for contrast.
sink.write(bytes)

//! expect: written=bytes:3,text:hi,bytes:3
console.log('written=' + sink.written.join(','))
