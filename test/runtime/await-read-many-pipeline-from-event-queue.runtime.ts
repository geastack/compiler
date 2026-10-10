// A DATABASE CLIENT'S `readMany` PIPELINE, END TO END, WITH TIMER-DELIVERED DATA.
//
// `Connection.readMany` is an async generator doing `for await` over
// `onData(messageStream)`: a hand-written async iterator OBJECT LITERAL whose
// `next()` returns a Promise -- resolved at once from a buffer of unconsumed
// events, or parked in a list of pending resolvers until the next 'data'
// event -- and whose `[Symbol.asyncIterator]` returns `this`. The command
// path does `for await (const response of this.readMany(...))`, and
// `readMany` `return`s out of its loop once a response is complete, which
// calls the iterator's `return()` to remove the listener.
//
// Two commands run at once over two emitters fed by timers: one timer
// delivers two chunks together (the buffered path), the others one each (the
// parked-resolver path).
//
// The blocking model parked the consumer in a nested pump inside the promise
// `next()` returned. Here the first `await` blocks at the top level before any
// timer runs; in the real client, where the event loop is already running,
// the pipeline ran inside the pump of whichever await started it, and a second
// pipeline started meanwhile deadlocked behind it. Observed on the blocking
// build: nothing printed, then
//   gea: pending promise has no host work capable of settling it
//   CRASHED: SIGABRT
//
// This suite's target has no `setTimeout`, so the timers are a program-owned
// queue in virtual time (see
// `await-deadlock-shape-timer-started-loop-does-not-block-main.runtime.ts`).
// The real-timer version is node-compat's `correctness/native/async-await-timers.ts`.
interface Timer {
  due: number
  order: number
  run: () => void
}

const timers: Timer[] = []
let now = 0
let scheduled = 0

function setVirtualTimeout(run: () => void, ms: number): void {
  timers.push({ due: now + ms, order: scheduled, run })
  scheduled += 1
}

function takeNextTimer(): Timer | undefined {
  let best = -1
  for (let i = 0; i < timers.length; i++) {
    const candidate = timers[i]!
    const current = best < 0 ? undefined : timers[best]!
    if (current === undefined || candidate.due < current.due || (candidate.due === current.due && candidate.order < current.order)) best = i
  }
  if (best < 0) return undefined
  return timers.splice(best, 1)[0]
}

async function settleJobs(): Promise<void> {
  for (let i = 0; i < 64; i++) await null
}

async function runTimers(): Promise<void> {
  await settleJobs()
  for (;;) {
    const timer = takeNextTimer()
    if (timer === undefined) break
    now = timer.due
    timer.run()
    await settleJobs()
  }
}

type Listener = (chunk: string) => void

class Emitter {
  private listeners: Listener[] = []

  on(listener: Listener): void {
    this.listeners.push(listener)
  }

  off(listener: Listener): void {
    this.listeners = this.listeners.filter((each) => each !== listener)
  }

  emit(chunk: string): void {
    for (const listener of this.listeners.slice()) listener(chunk)
  }

  count(): number {
    return this.listeners.length
  }
}

const log: string[] = []

type PendingPromise = { resolve: (value: IteratorResult<string>) => void }

function onData(emitter: Emitter, name: string): AsyncGenerator<string> {
  const unconsumedEvents: string[] = []
  const unconsumedPromises: PendingPromise[] = []
  let finished = false

  function eventHandler(value: string): void {
    const pending = unconsumedPromises.shift()
    if (pending != null) pending.resolve({ value, done: false })
    else unconsumedEvents.push(value)
  }

  function closeHandler(): Promise<IteratorResult<string>> {
    log.push(`${name}:events-return`)
    finished = true
    emitter.off(eventHandler)
    const doneResult = { value: undefined, done: true } as const
    for (const pending of unconsumedPromises.splice(0)) pending.resolve(doneResult)
    return Promise.resolve(doneResult)
  }

  const iterator: AsyncGenerator<string> = {
    next() {
      const value = unconsumedEvents.shift()
      if (value != null) return Promise.resolve({ value, done: false })
      if (finished) return closeHandler()
      return new Promise<IteratorResult<string>>((resolve) => {
        unconsumedPromises.push({ resolve })
      })
    },
    return() {
      return closeHandler()
    },
    throw(error: Error) {
      return Promise.reject(error)
    },
    [Symbol.asyncIterator]() {
      return this
    }
  }

  emitter.on(eventHandler)
  return iterator
}

async function* readMany(emitter: Emitter, name: string): AsyncGenerator<string> {
  try {
    for await (const chunk of onData(emitter, name)) {
      const response = await Promise.resolve(`${name}:${chunk.toUpperCase()}`)
      yield response
      if (chunk.endsWith('!')) return
    }
  } finally {
    log.push(`${name}:readMany-finally`)
  }
}

async function command(emitter: Emitter, name: string): Promise<string[]> {
  const responses: string[] = []
  for await (const response of readMany(emitter, name)) {
    log.push(`${response}@${now}`)
    responses.push(response)
  }
  log.push(`${name}:done listeners=${emitter.count()}`)
  return responses
}

const first = new Emitter()
const second = new Emitter()

setVirtualTimeout(() => {
  first.emit('a')
  first.emit('b')
}, 5)
setVirtualTimeout(() => second.emit('x'), 8)
setVirtualTimeout(() => first.emit('c'), 10)
setVirtualTimeout(() => second.emit('y!'), 12)
setVirtualTimeout(() => first.emit('d!'), 15)
setVirtualTimeout(() => first.emit('ignored'), 18)

async function main(): Promise<void> {
  const one = command(first, 'one')
  const two = command(second, 'two')
  const oneResult = await one
  const twoResult = await two
  console.log(log.join(' '))
  console.log(`one=${oneResult.join(',')} two=${twoResult.join(',')}`)
}

main()
runTimers()
//! expect: one:A@5 one:B@5 two:X@8 one:C@10 two:Y!@12 two:events-return two:readMany-finally two:done listeners=0 one:D!@15 one:events-return one:readMany-finally one:done listeners=0
//! expect: one=one:A,one:B,one:C,one:D! two=two:X,two:Y!
