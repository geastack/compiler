//! expect: bytes 7
//! expect: took bytes
//! expect: wide empty

// A generic class whose copies must SPLIT -- `unknown` and `Uint8Array` reach
// its mutable `items`, so they are two layouts -- while holding a generic
// INTERFACE keyed on the same parameter. The interface's callback mentions a
// third generic class, so its calling convention differs per copy too: if the
// interface does not split with the class, one copy's read of `sink.take`
// produces the other copy's convention and no conversion exists.
// Reduced from node-compat's `whatwg-streams.ts`, where `ReadableStream<R>`
// holds `UnderlyingReadableStreamSource<R>` whose `start`/`pull` take
// `ReadableStreamDefaultController<R>`.
class Handle<T> {
  constructor(readonly bag: Bag<T>) {}
}

interface Sink<T> {
  take?(handle: Handle<T>): void
}

class Bag<T> {
  private items: T[] = []
  private sink: Sink<T>

  constructor(sink: Sink<T> = {}) {
    this.sink = sink
  }

  push(item: T): void {
    this.items.push(item)
  }

  fill(): void {
    const take = this.sink.take
    if (take !== undefined) take(new Handle<T>(this))
  }

  size(): number {
    return this.items.length
  }

  first(): T {
    return this.items[0] as T
  }
}

const chunk = new Uint8Array(1)
chunk[0] = 7
const bytes = new Bag<Uint8Array>({
  take: (handle: Handle<Uint8Array>): void => {
    handle.bag.push(chunk)
  }
})
bytes.fill()
console.log(`bytes ${bytes.first()[0]}`)
console.log(`took ${bytes.size() === 1 ? 'bytes' : 'nothing'}`)

const wide = new Bag<unknown>()
wide.fill()
console.log(`wide ${wide.size() === 0 ? 'empty' : 'filled'}`)
