//! expect: typed 7
//! expect: generic 2
//! expect: typed-count 1
//! emitted-has: gea::host::exactArm<
// `@gea-exact-arms` on an overload implementation: the union parameter
// entering a slot that is exactly ONE of its arms projects that arm instead of
// the per-arm dispatch.
//
// Node's `on(name, fn)` is the shape: typed listeners for known names, a
// generic `(...args: unknown[])` handler for the rest. Without the tag,
// `fn as Typed` under `Typed | Generic` renders `fn.is<0>() ? adapt(fn.get<0>())
// : fn.get<1>()` -- TS function assignability lets the generic arm become a
// `Typed`, so the dispatch installs an adapter for it, and that adapter boxes
// the typed arm's parameters to feed the generic listener. The reflection
// census then promotes every parameter type to `full`, which is the entire
// cost this feature exists to avoid. The tag says: the branch guarding the
// cast excludes the other arms, project or throw.
type Typed = (n: number) => number
type Generic = (...args: unknown[]) => number

class Bus {
  private readonly typed: Typed[] = []
  private readonly generic: Generic[] = []

  add(name: 'typed', fn: Typed): void
  add(name: string, fn: Generic): void
  /** @gea-exact-arms */
  add(name: string, fn: Typed | Generic): void {
    if (name === 'typed') this.typed.push(fn as Typed)
    else this.generic.push(fn as Generic)
  }

  runTyped(n: number): number {
    let total = 0
    for (const fn of this.typed) total = total + fn(n)
    return total
  }

  runGeneric(): number {
    let total = 0
    for (const fn of this.generic) total = total + fn()
    return total
  }

  typedCount(): number {
    return this.typed.length
  }
}

const bus = new Bus()
bus.add('typed', (n: number) => n + 4)
bus.add('other', () => 2)
console.log('typed', bus.runTyped(3))
console.log('generic', bus.runGeneric())
console.log('typed-count', bus.typedCount())
