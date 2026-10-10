// A database client's `TypedEventEmitter<Events>` re-declares `listeners`
// through a merged interface as `Events[K][]`, while the body it runs is
// node's `EventEmitter.listeners`, whose elements are stored `Listener`s --
// callables that declare `this: EventEmitter` because `emit` applies them to
// the emitter. The view's event signatures are method shorthands: none of
// them can supply that receiver, so no stored listener converts into the
// view, and the result is the body's own `Listener[]`.
//
// Two client shapes: a cursor tracker asks
// `this.listeners('close').includes(removeActiveCursor)` before `once`, and
// a topology's sharding detection asks the same through an optional chain,
// `this.s.srvPoller?.listeners(...)`, whose result keeps its `undefined`.
// `includes` must find the registered function by identity, and the array a
// `listeners()` call returns is its own copy: node returns a new one per call.
type Listener = (this: Emitter, ...args: any[]) => unknown
type GenericListener = (...args: any[]) => void

class Emitter {
  private names: string[] = []
  private fns: Listener[] = []
  on(name: string, fn: Listener): this {
    this.names.push(name)
    this.fns.push(fn)
    return this
  }
  once(name: string, fn: Listener): this {
    return this.on(name, fn)
  }
  emit(name: string, ...args: any[]): number {
    let count = 0
    for (const fn of this.listeners(name)) {
      fn.apply(this, args)
      count++
    }
    return count
  }
  listeners(name: string): Listener[] {
    const out: Listener[] = []
    for (let i = 0; i < this.names.length; i++) if (this.names[i] === name) out.push(this.fns[i]!)
    return out
  }
}

type EventsDescription = Record<string, GenericListener>

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
declare interface Typed<Events extends EventsDescription> extends Emitter {
  on<K extends keyof Events>(event: K, listener: Events[K]): this
  on(event: string, listener: GenericListener): this
  once<K extends keyof Events>(event: K, listener: Events[K]): this
  once(event: string, listener: GenericListener): this
  listeners<K extends keyof Events>(event: K | string): Events[K][]
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class Typed<Events extends EventsDescription> extends Emitter {}

interface PollEvent {
  hosts: string[]
}
type PollerEvents = { discovery(event: PollEvent): void }
type CursorEvents = { close(): void }

class Poller extends Typed<PollerEvents> {}

const log: string[] = []

function removeActive(this: Cursor): void {
  log.push('closed ' + this.name)
}

class Cursor extends Typed<CursorEvents> {
  constructor(readonly name: string) {
    super()
  }
  track(): number {
    if (!this.listeners('close').includes(removeActive)) this.once('close', removeActive)
    return this.listeners('close').length
  }
}

class Topology {
  poller: Poller | undefined = new Poller()
  readonly onDiscovery = (event: PollEvent): void => {
    log.push('discovered ' + event.hosts.join('+'))
  }
  detect(): boolean {
    const found = this.poller?.listeners('discovery')
    const listening = !!found?.includes(this.onDiscovery)
    if (!listening) this.poller?.on('discovery', this.onDiscovery)
    return listening
  }
}

const cursor = new Cursor('c1')
console.log('track', cursor.track(), cursor.track())
cursor.emit('close')

const topology = new Topology()
console.log('detect', topology.detect(), topology.detect())
const copy = topology.poller!.listeners('discovery')
copy.pop()
console.log('copy', copy.length, topology.poller!.listeners('discovery').length, topology.poller!.emit('discovery', { hosts: ['a', 'b'] }))
topology.poller = undefined
console.log('gone', topology.detect())
console.log(log.join(','))
//! expect: track 1 1
//! expect: detect false true
//! expect: copy 0 1 1
//! expect: gone false
//! expect: closed c1,discovered a+b
