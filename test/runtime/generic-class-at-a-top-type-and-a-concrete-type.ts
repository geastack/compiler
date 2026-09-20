//! expect: bytes 7
//! expect: wide holds x
//! expect: wide size 1

// A generic class held at a TOP type and at a concrete one, with the filling
// reaching a MUTABLE field. `unknown` (like `any`) carries the dynamic
// carrier, and the two copies are mutually assignable, so the class does not
// split -- one struct serves both. Which copy's carrier that struct takes is
// then the whole question: `dynamic` refuses the concrete copy's reads, and
// an `array-object` element conversion is refused in BOTH directions because
// viewing a `Uint8Array[]` as an `unknown[]` and pushing through it would
// alias. The struct has to take the CONCRETE carrier and the top copy's reads
// widen out of it.
//
// Reduced from node-compat's `ReadableStream<R>` (`private queue_: R[]`) held
// at `R = unknown` and `R = Uint8Array`, which is what the whole hono build
// stopped emitting on.
class Queue<R> {
  private items: R[] = []

  push(item: R): void {
    this.items.push(item)
  }

  first(): R {
    return this.items[0] as R
  }

  size(): number {
    return this.items.length
  }
}

const bytes = new Queue<Uint8Array>()
const chunk = new Uint8Array(1)
chunk[0] = 7
bytes.push(chunk)
console.log(`bytes ${bytes.first()[0]}`)

const wide = new Queue<unknown>()
wide.push('x')
console.log(`wide holds ${String(wide.first())}`)
console.log(`wide size ${wide.size()}`)
