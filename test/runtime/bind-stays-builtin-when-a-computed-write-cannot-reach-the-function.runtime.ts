//! expect: warn:disk low
//! expect: cleared:true failed:false
//! expect: merged:{"a":1,"b":2}
//! emitted-has: gea::bindCallable

// A database client's logger and connection: `this.log.bind(this, 'warn')`
// and `this.clearPendingLog.bind(this)` on a class whose instances never enter
// a dynamic value, in a program that elsewhere writes a computed key on an
// `any`-typed object (the client's option merging). That write can only reach
// objects the box can hold; neither the logger's methods nor its instances
// ever become one, so `bind` stays the intrinsic Function.prototype.bind.

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

function merge(target: any, source: Record<string, number>): any {
  for (const key of Object.keys(source)) target[key] = source[key]
  return target
}

const logger = new Logger()
logger.warn('disk low')
logger.flush().then(() => {
  console.log('cleared:' + logger.cleared + ' failed:' + logger.failed)
  console.log('merged:' + JSON.stringify(merge({ a: 1 }, { b: 2 })))
})
