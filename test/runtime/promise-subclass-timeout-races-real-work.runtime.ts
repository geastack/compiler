// A database client's `Timeout` is `class Timeout extends Promise<never>`:
// its constructor calls `super(executor)` and captures the executor's
// `reject`, it carries timer state as own fields, and callers race it against
// real work with `Promise.race([work, timeout])` / `Promise.all`. The instance
// IS a promise -- `await`, `.then` and the combinators settle from it -- and it
// is also a class with its own fields and methods.
type Reject = (reason?: unknown) => void

let fire: () => void = () => {}

class Timeout extends Promise<never> {
  public readonly duration: number
  public timedOut = false
  public cleared = false

  private constructor(executor: (resolve: (value: never) => void, reject: Reject) => void = () => null, duration = 0) {
    let reject!: Reject
    super((_, promiseReject) => {
      reject = promiseReject
      executor(() => {}, promiseReject)
    })
    this.duration = duration
    if (duration > 0) {
      fire = () => {
        this.timedOut = true
        reject(new Error(`Expired after ${duration}ms`))
      }
    }
  }

  clear(): void {
    this.cleared = true
  }

  // The client's `throwIfExpired`: `this.then(...)` reads `then` off the promise
  // the receiver IS, from inside one of the class's own methods.
  throwIfExpired(): void {
    if (this.timedOut) {
      this.then(undefined, squash)
      throw new Error('Timed out')
    }
  }

  static expires(duration: number): Timeout {
    return new Timeout(undefined, duration)
  }
}

// The client's `throwIfExpired` squashes the rejection it is about to throw itself.
function squash(error: unknown): void {
  console.log('then', error instanceof Error ? error.message : '?')
}

let finishWork: (value: string) => void = () => {}
const work = (): Promise<string> => new Promise<string>((resolve) => (finishWork = resolve))

async function main(): Promise<void> {
  const first = Timeout.expires(10)
  console.log(first.duration, first.timedOut, first.cleared)
  const won = Promise.race([work(), first])
  finishWork('work')
  first.clear()
  console.log(await won, first.cleared)

  const second = Timeout.expires(20)
  const lost = Promise.race([work(), second])
  fire()
  try {
    await lost
    console.log('unreachable')
  } catch (error) {
    console.log(error instanceof Error ? error.message : 'not an error', second.timedOut)
  }
  try {
    second.throwIfExpired()
  } catch (error) {
    console.log('thrown', error instanceof Error ? error.message : '?')
  }

  const third = Timeout.expires(30)
  const both = Promise.all([Promise.resolve(), third])
  fire()
  try {
    await both
  } catch (error) {
    console.log('all', error instanceof Error ? error.message : 'not an error')
  }

  const fourth = Timeout.expires(40)
  fourth.then(undefined, squash)
  fire()
  try {
    await fourth
  } catch (error) {
    console.log('await', error instanceof Error ? error.message : '?', fourth instanceof Promise, fourth instanceof Timeout)
  }

  // Held where a `Promise<string>` is declared: `never` fulfills nothing, so
  // the store is the upcast, and the rejection still arrives through it.
  const fifth: Promise<string> = Timeout.expires(50)
  fire()
  try {
    console.log(await fifth)
  } catch (error) {
    console.log('held', error instanceof Error ? error.message : '?')
  }
}
//! expect: 10 false false
//! expect: work true
//! expect: Expired after 20ms true
//! expect: thrown Timed out
//! expect: then Expired after 20ms
//! expect: all Expired after 30ms
//! expect: then Expired after 40ms
//! expect: await Expired after 40ms true true
//! expect: held Expired after 50ms
main()
