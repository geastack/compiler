// A database client's encryption wrapper re-registering listeners on its internal client:
//
//   for (const eventName of CLIENT_EVENTS)
//     for (const listener of client.listeners(eventName)) internalClient.on(eventName, listener)
//
// `eventName` is the union of every event key, so `listeners(eventName)` is
// typed `Events[K][]` for that whole union -- one element type per event -- and
// `on(eventName, listener)` resolves the typed overload with the same union.
// Physically the emitter stores ONE callable carrier (`Listener`), and the
// listener re-registered on the second emitter must be the SAME function object:
// removing it by identity afterwards has to work.
type GenericListener = (...args: any[]) => void
type Listener = (this: Emitter, ...args: any[]) => unknown

class Emitter {
  private names: string[] = []
  private fns: Listener[] = []
  on(name: string, fn: Listener): this {
    this.names.push(name)
    this.fns.push(fn)
    return this
  }
  removeListener(name: string, fn: Listener): this {
    for (let i = 0; i < this.names.length; i++) {
      if (this.names[i] === name && this.fns[i] === fn) {
        this.names.splice(i, 1)
        this.fns.splice(i, 1)
        break
      }
    }
    return this
  }
  listeners(name: string): Listener[] {
    const out: Listener[] = []
    for (let i = 0; i < this.names.length; i++) if (this.names[i] === name) out.push(this.fns[i]!)
    return out
  }
  count(name: string): number {
    let n = 0
    for (const each of this.names) if (each === name) n++
    return n
  }
  emit(name: string, ...args: any[]): boolean {
    let any = false
    for (const fn of this.listeners(name)) {
      fn.apply(this, args)
      any = true
    }
    return any
  }
}

type EventsDescription = Record<string, GenericListener>

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
declare interface Typed<Events extends EventsDescription> extends Emitter {
  on<K extends keyof Events>(event: K, listener: Events[K]): this
  on(event: string, listener: GenericListener): this
  removeListener<K extends keyof Events>(event: K, listener: Events[K]): this
  removeListener(event: string, listener: GenericListener): this
  listeners<K extends keyof Events>(event: K | string): Events[K][]
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class Typed<Events extends EventsDescription> extends Emitter {}

type TopologyEvents = {
  opened(port: number): void
  named(name: string): void
  closed(): void
  internal(): void
}

const CLIENT_EVENTS = Object.freeze(['opened', 'named', 'closed'] as const)

type ClientEvents = Pick<TopologyEvents, (typeof CLIENT_EVENTS)[number]> & {
  open(client: Client): void
}

class Client extends Typed<ClientEvents> {}

const client = new Client()
const inner = new Client()
const onOpened = (port: number): void => console.log('opened', port)
client.on('opened', onOpened)
client.on('named', (name: string) => console.log('named', name))
client.on('closed', () => console.log('closed'))

for (const eventName of CLIENT_EVENTS) {
  for (const listener of client.listeners(eventName)) {
    inner.on(eventName, listener)
  }
}

inner.emit('opened', 8080)
inner.emit('named', 'server')
inner.emit('closed')
inner.removeListener('opened', onOpened)
console.log(inner.count('opened'), inner.count('named'))
//! expect: opened 8080
//! expect: named server
//! expect: closed
//! expect: 0 1
