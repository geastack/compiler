//! expect-refusal: a method compiled for receivers of class
// KNOWN GAP, pinned as a refusal: the same program as `generic-reader-family-at-any-and-concrete-copies`
// with a subclass reader that OVERRIDES `read` with a different convention. A method read through the
// receiver spelled at `any` (the union of every copy) publishes the any copy's exact receiver while
// each arm's body takes its own, so the per-arm method value has no convention to fill; the
// override-free family dispatches per arm and does not hit it. Fixing it means publishing the union
// receiver for such reads. A stream class generic over its chunk type, instantiated at its default `Uint8Array` and at `any`
// (the module surface of a streams library: bytes for the library's own consumers, any chunk for a
// program that builds one). The reader family is wired through the stream in both directions -- the
// reader releases itself into the stream (`this` passed to a method of the stream copy it belongs
// to), a subclass reader overrides `read` with an extra optional parameter, and an iterator reads
// through a base-typed reader field -- so each copy's methods are called from a class of the same
// copy and none may be read through another copy's bound-method convention.
type ReadResult<R> = { done: false; value: R } | { done: true; value: undefined }

class Controller<R = Uint8Array> {
  private stream_: Stream<R>
  constructor(stream: Stream<R>) {
    this.stream_ = stream
  }
  enqueue(chunk: R): void {
    this.stream_.push(chunk)
  }
}

class Stream<R = Uint8Array> {
  private queue_: R[] = []
  private reader_: Reader<R> | null = null
  constructor(start?: (controller: Controller<R>) => void) {
    if (start !== undefined) start(new Controller<R>(this))
  }
  push(chunk: R): void {
    this.queue_.push(chunk)
  }
  take(): ReadResult<R> {
    if (this.queue_.length === 0) return { done: true, value: undefined }
    return { done: false, value: this.queue_.shift() as R }
  }
  getReader(options: { mode?: string } = {}): Reader<R> {
    const reader = options.mode === 'byob' ? new ByobReader<R>(this) : new Reader<R>(this)
    this.reader_ = reader
    return reader
  }
  release(reader: Reader<R>): void {
    if (this.reader_ === reader) this.reader_ = null
  }
  values(): Iter<R> {
    return new Iter<R>(this)
  }
}

class Reader<R = Uint8Array> {
  protected stream_: Stream<R> | null
  constructor(stream: Stream<R>) {
    this.stream_ = stream
  }
  read(): Promise<ReadResult<R>> {
    if (this.stream_ === null) return Promise.resolve({ done: true, value: undefined })
    return Promise.resolve(this.stream_.take())
  }
  releaseLock(): void {
    const stream = this.stream_
    if (stream === null) return
    this.stream_ = null
    stream.release(this)
  }
}

class ByobReader<R = Uint8Array> extends Reader<R> {
  override read(view?: Uint8Array): Promise<ReadResult<R>> {
    return super.read().then((result) => {
      if (result.done || view === undefined) return result
      return result
    })
  }
}

class Iter<R = Uint8Array> {
  private reader_: Reader<R>
  constructor(stream: Stream<R>) {
    this.reader_ = stream.getReader()
  }
  next(): Promise<ReadResult<R>> {
    return this.reader_.read()
  }
}

const bytes = new Stream((c: Controller) => c.enqueue(new Uint8Array(3)))
const byteReader = bytes.getReader()
byteReader.read().then((r) => {
  if (!r.done) console.log('bytes=' + r.value.length)
  byteReader.releaseLock()
})

const dynamic = new Stream<any>((c: Controller<any>) => {
  const dynamicController: any = c
  dynamicController.enqueue('first')
  dynamicController.enqueue('second')
})
const dynamicReader: any = dynamic.getReader()
dynamicReader.read().then((r: any) => {
  console.log('dyn=' + r.value)
  dynamicReader.releaseLock()
  const iterator = dynamic.values()
  iterator.next().then((n) => {
    if (!n.done) console.log('iter=' + n.value)
  })
})
