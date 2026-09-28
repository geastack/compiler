//! expect: true 1 x
//! expect: true 2 x
// A compiled method called through a box receives a JavaScript function for a
// parameter whose convention has a receiver and a rest slot -- `(this, ...args)`
// spells the same C++ type as `(a, args)`, so the function must still be
// adapted with its own convention, not as two positional arguments.
type Handler = (this: unknown, ...args: unknown[]) => unknown

class Hub {
  private readonly handlers: Handler[] = []
  on(fn: Handler): this {
    this.handlers.push(fn)
    return this
  }
  fire(...args: unknown[]): void {
    for (const handler of this.handlers) handler.apply(this, args)
  }
}

const hub: any = JSON.parse('0') === 0 ? new Hub() : null
hub.on(function (this: unknown, value: unknown, tag: unknown) {
  console.log(this === hub, value, tag)
})
hub.fire(1, 'x')
hub.fire(2, 'x')
