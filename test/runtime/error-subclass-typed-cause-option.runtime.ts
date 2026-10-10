// `super(message, options)` where the options bag states a TYPED cause --
// a database client's `ServiceError` (`options?: { cause?: Error }`) and `TimeoutError`
// (`options: { cause?: Error; duration: number }`). The intrinsic Error's own
// `cause` slot is declared `unknown`, so the typed cause widens into it.
class DriverError extends Error {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options)
  }
}
class TimedOut extends Error {
  duration: number
  constructor(message: string, options: { cause?: Error; duration: number }) {
    super(message, options)
    this.duration = options.duration
  }
}

const root = new Error('socket closed')
const wrapped = new DriverError('command failed', { cause: root })
const bare = new DriverError('no cause')
const timed = new TimedOut('timed out', { cause: wrapped, duration: 30 })
const direct = new Error('outer', { cause: timed } as { cause?: Error })

console.log(wrapped.message, wrapped.cause === root, (wrapped.cause as Error).message)
console.log(bare.message, 'cause' in bare, bare.cause === undefined)
console.log(timed.duration, timed.cause === wrapped, ((timed.cause as Error).cause as Error).message)
console.log(direct.cause === timed)

//! expect: command failed true socket closed
//! expect: no cause false true
//! expect: 30 true socket closed
//! expect: true
