//! expect: caught TypeError
//! expect: typed-count 0
// The other half of `exact-arm-projection.ts`: an `@gea-exact-arms` body
// whose guard does NOT exclude the other arm. The projection is a runtime
// check the author vouched for, so a value holding a different arm must
// surface as a `TypeError` the program can catch -- never a reinterpretation
// of the other arm's bytes, and never a silent adapter.
type Typed = (n: number) => number
type Generic = (...args: unknown[]) => number

class Bus {
  private readonly typed: Typed[] = []

  add(name: 'typed', fn: Typed): void
  add(name: string, fn: Generic): void
  /** @gea-exact-arms */
  add(_name: string, fn: Typed | Generic): void {
    // Wrong on purpose: every listener is stored as `Typed`, so a generic
    // handler reaches the projection holding the other arm.
    this.typed.push(fn as Typed)
  }

  typedCount(): number {
    return this.typed.length
  }
}

const bus = new Bus()
try {
  bus.add('other', () => 2)
  console.log('unreachable')
} catch (error) {
  console.log('caught', error instanceof TypeError ? 'TypeError' : 'other')
}
console.log('typed-count', bus.typedCount())
