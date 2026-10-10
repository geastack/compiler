//! expect: armed
//! expect: armed
//! expect: rejected Expired after 1ms
// A database client's `onData`: `timeoutContext?.timeoutForSocketRead?.then(undefined,
// errorHandler)`, where `timeoutForSocketRead` is `Timeout | null` and
// `Timeout` extends `Promise<never>`. The receiver reaches the read as a union
// one arm of which is the Promise subclass; `then` is no member the class
// declares, so that arm answers from its native promise base.
//
// node prints:
//   armed
//   armed
//   rejected Expired after 1ms
type Executor = (resolve: (value: never) => void, reject: (reason: Error) => void) => void
const noop = () => {}

class Timeout extends Promise<never> {
  private constructor(executor: Executor = () => null, options?: { duration: number; rejection?: Error }) {
    let reject!: (reason: Error) => void
    super((_, promiseReject) => {
      reject = promiseReject
      executor(noop, promiseReject)
    })
    if (options?.rejection != null) reject(options.rejection)
  }
  static expires(duration: number): Timeout {
    return new Timeout(undefined, { duration, rejection: new Error(`Expired after ${duration}ms`) })
  }
}

class TimeoutContext {
  private readonly timeout: Timeout | null
  constructor(duration: number) {
    this.timeout = duration > 0 ? Timeout.expires(duration) : null
  }
  get timeoutForSocketRead(): Timeout | null {
    return this.timeout
  }
}

const onData = (timeoutContext: TimeoutContext | undefined) => {
  const timeoutForSocketRead = timeoutContext?.timeoutForSocketRead
  timeoutForSocketRead?.then(undefined, (error: Error) => console.log('rejected', error.message))
  console.log('armed')
}

onData(new TimeoutContext(1))
onData(undefined)
