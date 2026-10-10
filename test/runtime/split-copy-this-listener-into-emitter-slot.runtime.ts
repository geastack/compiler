// A function declaring `this: Box` -- the `any` filling of a split generic
// class -- registered with an emitter whose listener slot carries the emitter
// as its receiver. A database client's `removeActiveCursor(this:
// AbstractCursor)` is the measured case: `AbstractCursor.trackCursor` does
// `this.once('close', removeActiveCursor)` and node's EventEmitter calls it with
// `fn.apply(this, args)`, so the function runs with the cursor that emitted.
//
// The public overload types the listener `() => void`, as the client's
// `TypedEventEmitter` types it `Events['close']`; the implementation's slot
// carries the receiver. The slot's receiver is the base class. The function accepts only Box copies,
// so the adapter narrows the receiver to the copy that is live, checked, and
// drops the arguments the function never declared.
type Handler = (this: Emitter, ...args: any[]) => unknown

class Emitter {
  private fns: Handler[] = []
  on(fn: () => void): this
  on(fn: Handler): this {
    this.fns.push(fn)
    return this
  }
  has(fn: () => void): boolean
  has(fn: Handler): boolean {
    return this.fns.includes(fn)
  }
  emit(...args: any[]): void {
    for (const fn of this.fns) fn.apply(this, args)
  }
}

class Box<T = any> extends Emitter {
  constructor(
    public value: T,
    public tag: string
  ) {
    super()
  }
}

function show(this: Box) {
  console.log(this.tag, String(this.value))
}

const a = new Box<number>(1, 'a')
const b = new Box<string>('x', 'b')
const c = new Box<any>(true, 'c')
a.on(show)
if (!b.has(show)) b.on(show)
c.on(show)
a.emit(9)
b.emit()
c.emit('ignored', 2)
console.log(a.has(show), b.has(show))
//! expect: a 1
//! expect: b x
//! expect: c true
//! expect: true true
