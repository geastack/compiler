//! expect: error:connection refused
//! expect: debug:pool ready
//! expect: ended:true
//! expect: cleared:true failed:false
//! expect: same:true
//! expect: merged:{"a":1,"b":2}
//! emitted-has: gea::callableBindIsIntrinsic

// A database client's logger and connection: `this.log.bind(this,
// 'error')`, `this.clearPendingLog.bind(this)`, on classes whose instances
// DO reach dynamic code -- the session's `this.emit('ended', this)` hands the
// session to an EventEmitter's `unknown[]` listener arguments. The census
// marks the class fully reflected, and the client's option merging writes a
// computed key through an `any`, so it cannot prove `bind` unshadowed; the
// bind is lowered natively behind a run-time own-`bind` check, which nothing
// here trips. `same` pins that a boxed read of a method is the one Function
// object the native read is: the check is only sound if both agree.

type Listener = (...args: unknown[]) => void

class Emitter {
  private listeners: Listener[] = []
  on(listener: Listener): void {
    this.listeners.push(listener)
  }
  emit(...args: unknown[]): void {
    for (const listener of this.listeners) listener(...args)
  }
}

class ClientLogger extends Emitter {
  pending: Promise<unknown> | null = null
  cleared = false
  failed = false
  error = this.log.bind(this, 'error')
  debug = this.log.bind(this, 'debug')

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

  end(): void {
    this.emit('ended', this)
  }
}

function merge(target: any, source: Record<string, number>): any {
  for (const key of Object.keys(source)) target[key] = source[key]
  return target
}

const logger = new ClientLogger()
logger.on((event, self) => {
  const held = self as any
  console.log(String(event) + ':' + (held === logger))
  console.log('same:' + (held.flush === held.flush))
})
logger.error('connection refused')
logger.debug('pool ready')
logger.end()
logger.flush().then(() => {
  console.log('cleared:' + logger.cleared + ' failed:' + logger.failed)
  // The merged keys come from parsed text, so no proven key set (`provenKeyTexts`)
  // rules out a computed write of `bind`.
  console.log('merged:' + JSON.stringify(merge({ a: 1 }, JSON.parse('{"b":2}'))))
})
