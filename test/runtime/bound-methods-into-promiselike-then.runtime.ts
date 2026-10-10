// BOUND `() => void` METHODS HANDED TO `then` AS ITS OPTIONAL CALLBACKS.
//
// A database client's `ClientLogger.log` chains a pending sink write
// with `.then(this.clearPendingLog.bind(this), this.logWriteFailureHandler.bind(this))`.
// `then`'s parameters are `((value) => TResult | PromiseLike<TResult>) | undefined | null`,
// so with `TResult = void` each slot's result is `void | PromiseLike<void>`;
// a bound `() => void` is a value of it, and completing without a value
// returns `undefined` into that result. The fulfilled handler runs on
// resolution, the rejected one on rejection, each with `this` the logger.

class Logger {
  pendingLog: Promise<unknown> | null = null
  events: string[] = []

  private clearPendingLog(): void {
    this.events.push('cleared')
    this.pendingLog = null
  }

  private logWriteFailureHandler(error: Error): void {
    this.events.push(`failed:${error.message}`)
    this.clearPendingLog()
  }

  log(result: Promise<unknown>): void {
    if (this.pendingLog !== null) {
      this.pendingLog = this.pendingLog.then(this.clearPendingLog.bind(this), this.logWriteFailureHandler.bind(this))
      return
    }
    this.pendingLog = result.then(this.clearPendingLog.bind(this), this.logWriteFailureHandler.bind(this))
  }
}

// The same slot as a plain parameter: the callback's `void` completion is the
// `undefined` arm of `void | PromiseLike<void>`.
function settleWith(callback: (value: unknown) => void | PromiseLike<void>): string {
  return String(callback(1))
}

const logger = new Logger()
logger.log(Promise.resolve('ok'))
logger.log(Promise.resolve('queued'))
const failing = new Logger()
failing.log(Promise.reject(new Error('boom')))
let calls = 0

//! expect: direct=undefined calls=1
console.log(`direct=${settleWith(() => void calls++)} calls=${calls}`)

const settle = async (): Promise<void> => {
  const pending = [logger.pendingLog, failing.pendingLog]
  for (const settling of pending) if (settling !== null) await settling
  //! expect: events=cleared|cleared failing=failed:boom|cleared pending=null
  console.log(`events=${logger.events.join('|')} failing=${failing.events.join('|')} pending=${String(logger.pendingLog)}`)
}
void settle()
