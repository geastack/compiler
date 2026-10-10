// A generic method whose rest parameter is `Parameters<Events[K]>` for an
// event whose listener takes an ARRAY: a database client's
// `TypedEventEmitter.emitAndLog(event, ...args: Parameters<Events[EventKey]>)`
// forwarding `...args` into `emit(event, ...args: any[])`. `args` is the
// tuple `[Connection[]]` -- an array OF arrays -- and each copy's calling
// convention must declare it at that depth, not one level deeper or
// shallower.
class Connection {
  constructor(readonly id: number) {}
}
class Emitter {
  emit(event: string | symbol, ...args: any[]): boolean {
    console.log(String(event), args.length, Array.isArray(args[0]) ? `[${args[0].length}]` : typeof args[0])
    return true
  }
}
type Events = {
  closed(connections: Connection[]): void
  opened(connection: Connection): void
  ready(id: number, name: string): void
}
class TypedEmitter<E extends Record<string, (...args: any[]) => void>> extends Emitter {
  emitAndLog<K extends keyof E>(event: K | symbol, ...args: Parameters<E[K]>): void {
    this.emit(event as string | symbol, ...args)
  }
}
const emitter = new TypedEmitter<Events>()
emitter.emitAndLog('closed', [new Connection(1), new Connection(2)])
emitter.emitAndLog('opened', new Connection(3))
emitter.emitAndLog('ready', 4, 'x')
//! expect: closed 1 [2]
//! expect: opened 1 object
//! expect: ready 2 number
