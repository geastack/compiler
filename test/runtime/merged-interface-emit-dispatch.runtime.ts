// A class merged with an interface of the same name that re-declares an
// inherited method with a narrower, generic signature -- a database client's
// `TypedEventEmitter`. The interface member has no body: every call runs the
// base class's implementation, whatever the merged signature says.
type Description = Record<string, (...args: any[]) => void>

class Emitter {
  count = 0
  emit(name: string | symbol, ...args: readonly unknown[]): boolean {
    this.count += 1
    console.log('emit', String(name), args.length)
    return true
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
interface TypedEmitter<Events extends Description> extends Emitter {
  emit<Key extends keyof Events>(event: Key | symbol, ...args: Parameters<Events[Key]>): boolean
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class TypedEmitter<Events extends Description> extends Emitter {
  // A generic helper whose rest parameter is closed only per call site's
  // copy: each copy binds `Events` and `Key`, so `Parameters<...>` is a tuple.
  emitAndLog<Key extends keyof Events>(event: Key | symbol, ...args: Parameters<Events[Key]>): void {
    this.emit(event, ...args)
    console.log('logged', args.length, args[0])
  }
}

type CursorEvents = { close(): void; data(value: number): void }

class Cursor<Events extends CursorEvents = CursorEvents> extends TypedEmitter<Events> {
  finish(): void {
    // @ts-expect-error: generic Events may add parameters to 'close'
    this.emit('close')
  }
}

class Pool extends TypedEmitter<{ ready(id: number, name: string): void }> {
  start(): void {
    this.emit('ready', 7, 'primary')
    this.emitAndLog('ready', 8, 'secondary')
  }
}

const cursor = new Cursor()
cursor.finish()
cursor.emit('data', 3)
const pool = new Pool()
pool.start()
console.log(cursor.count, pool.count)
//! expect: emit close 0
//! expect: emit data 1
//! expect: emit ready 2
//! expect: logged 2 8
//! expect: 2 2
