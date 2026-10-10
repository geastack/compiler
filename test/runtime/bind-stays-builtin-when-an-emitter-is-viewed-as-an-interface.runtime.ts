//! expect: warn:disk low
//! expect: pausable:false
//! expect: socket-error:reset
//! expect: iterator-error:reset
//! expect: piped:ended drained:1
//! expect: cleared:true failed:false
//! expect: merged:{"a":1,"b":2}
//! emitted-has: gea::bindCallable

// A database client's logger and connection, reached through
// node-compat's `events.ts`: `EventIterator` reads an emitter as
// `emitter as unknown as PausableEmitterMethods` to probe for `pause` and
// `resume`, and stores arrows as its `this: EventEmitter` listeners. The
// class-to-interface view is a NATIVE record built from the instance's own
// members, and an arrow never receives the listener's `this` -- nothing
// about either is dynamic -- but the reflection census once read the view as
// an unknown boundary and the listener's receiver as an adapter input, and
// each promoted the whole emitter family to full reflection, and with it
// every class an emitter's fields reach: the logger a client holds, and the
// connection itself. `this.log.bind(this, 'warn')`, `this.clearPendingLog.bind(this)`
// and `this.onSocketError.bind(this)` were then refused as
// `call-abi:bind-shadowable`, although no boxed value ever holds any of those
// Function objects. `pipe` below is node-compat's `Readable.pipe`: a
// destination viewed as an interface whose methods have the class's own
// frames (`end` returning `this` into a `void` member), and a zero-argument
// thunk handed to a `(...args: any[]) => void` slot, which drops what the
// thunk returns. Neither boxes anything either. The program also writes a computed key on an `any`
// (utils.ts's option merging), which is what makes `bind` an assumption the
// census has to confirm at all.

interface PausableEmitterMethods {
  pause?: () => void
  resume?: () => void
}

type Listener = (this: Emitter, ...args: any[]) => unknown

class Emitter {
  private handlers: Listener[] = []

  on(handler: Listener): void {
    this.handlers.push(handler)
  }

  once(handler: Listener): this {
    this.handlers.push(handler)
    return this
  }

  emit(...args: any[]): void {
    for (let i = 0; i < this.handlers.length; i++) {
      const fn: Listener = this.handlers[i]!
      fn.apply(this, args)
    }
  }
}

class EventIterator {
  private errorListener: (error?: unknown) => void

  constructor(emitter: Emitter) {
    this.errorListener = (error?: unknown) => this.fail(error)
    emitter.on(this.errorListener)
  }

  private fail(error: unknown): void {
    console.log('iterator-error:' + String(error))
  }
}

class Logger {
  pending: Promise<unknown> | null = null
  cleared = false
  failed = false
  warn = this.log.bind(this, 'warn')

  private log(severity: string, message: string): void {
    console.log(severity + ':' + message)
  }

  private clearPendingLog(): void {
    this.cleared = true
    this.pending = null
  }

  private logWriteFailureHandler(error: Error): void {
    this.failed = error.message.length > 0
  }

  flush(): Promise<unknown> {
    this.pending = Promise.resolve(1).then(this.clearPendingLog.bind(this), this.logWriteFailureHandler.bind(this))
    return this.pending
  }
}

class Connection extends Emitter {
  logger: Logger

  constructor(logger: Logger) {
    super()
    this.logger = logger
    this.on(this.onSocketError.bind(this))
  }

  private onSocketError(reason: string): void {
    console.log('socket-error:' + reason)
  }
}

interface PipeDestination {
  end?(): void
  once(listener: Listener): void
}

class Sink extends Emitter {
  ended = false
  drained = 0

  end(): this {
    this.ended = true
    return this
  }

  resume(): this {
    this.drained++
    return this
  }
}

function later(callback: (...args: any[]) => void): void {
  callback()
}

function pipe<T>(destination: T): T {
  const target = destination as unknown as PipeDestination
  target.once(() => {
    if (typeof target.end === 'function') target.end()
  })
  return destination
}

class Client extends Emitter {
  logger = new Logger()
  connection = new Connection(this.logger)
}

function pausable(emitter: Emitter): boolean {
  const methods = emitter as unknown as PausableEmitterMethods
  const pause = methods.pause
  return typeof pause === 'function'
}

function merge(target: any, source: Record<string, number>): any {
  for (const key of Object.keys(source)) target[key] = source[key]
  return target
}

const client = new Client()
new EventIterator(client.connection)
const sink = pipe(new Sink())
sink.emit('finish')
later(() => sink.resume())
console.log('piped:' + (sink.ended ? 'ended' : 'open') + ' drained:' + sink.drained)
client.logger.warn('disk low')
console.log('pausable:' + pausable(client))
client.connection.emit('reset')
client.logger.flush().then(() => {
  console.log('cleared:' + client.logger.cleared + ' failed:' + client.logger.failed)
  console.log('merged:' + JSON.stringify(merge({ a: 1 }, { b: 2 })))
})
