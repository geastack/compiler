// Mirrors node-compat's `whatwg-streams.ts:99` shape: two mutually
// referencing generic classes whose type parameter defaults (`R =
// Uint8Array`), where the controller is constructed FROM INSIDE the stream
// and handed to a callback but never STORED on the stream as a field --
// exactly how `ReadableStream` builds a `ReadableStreamDefaultController<R>`
// and passes it to `source.start`/`source.pull` without keeping a reference
// of its own. That absence matters for `structural-instantiated-member.ts`'s
// `build()`/`pair()`: when `Stream` instead kept a `controller_: Controller<R>`
// field, this fixture's own cross-class member pairing (walking `Stream`'s
// fields to find `Controller`'s members) reached and recorded `enqueue`'s
// open type before the direct per-declaration loop over `Controller` ever
// got there, masking the code path the real bug lives on. Routing
// construction through a callback interface instead (`ControllerSink`,
// mirroring `UnderlyingReadableStreamSource`'s `start?`/`pull?`) removes that
// shortcut, so `Controller`'s own top-level member loop is first to ask the
// checker for `enqueue`'s instantiated type.
//
// A subclass extending the controller WITHOUT re-parameterizing it completes
// the shape -- exactly `ReadableByteStreamController extends
// ReadableStreamDefaultController`. (A second concrete instantiation at a
// different type argument, e.g. `Stream<unknown>` alongside `Stream<Uint8Array>`,
// also reproduces `copy.instantiated` being populated per copy -- but it
// additionally trips a SEPARATE, pre-existing runtime defect where storing an
// incompatible element into the array crashes with `gea: an assertion out of
// a dynamic value ... read a dynamic property whose value is not of the
// declared type` -- not this task's ABI blocker, so it is left out here.)
// Every method with a body allocates a function object (`DefineMethod`)
// regardless of whether anything reads it as a value, so `enqueue`'s own
// allocation must find a real calling convention here too.
interface ControllerSink<R> {
  start?(controller: Controller<R>): void
}

class Stream<R = Uint8Array> {
  private received_: R[] = []
  constructor(sink: ControllerSink<R>) {
    if (sink.start !== undefined) sink.start(new Controller<R>(this))
  }
  enqueueFromController(chunk?: R): void {
    if (chunk !== undefined) this.received_.push(chunk)
  }
  receivedLength(): number {
    return this.received_.length
  }
}

class Controller<R = Uint8Array> {
  private stream_: Stream<R>
  constructor(stream: Stream<R>) {
    this.stream_ = stream
  }
  get desiredSize(): number | null {
    return this.stream_.receivedLength()
  }
  close(): void {
    // no-op, mirrors ReadableStreamDefaultController's close()
  }
  enqueue(chunk?: R): void {
    this.stream_.enqueueFromController(chunk)
  }
  error(reason?: unknown): void {
    void reason
  }
}

class ByteController extends Controller {
  constructor(stream: Stream<Uint8Array>) {
    super(stream)
  }
}

const byteStream = new Stream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]))
  }
})
console.log(byteStream.receivedLength())

const viaSubclassStream = new Stream<Uint8Array>({})
const byteController = new ByteController(viaSubclassStream)
byteController.enqueue(new Uint8Array([4, 5]))
console.log(viaSubclassStream.receivedLength())
//! expect: 1
//! expect: 1
