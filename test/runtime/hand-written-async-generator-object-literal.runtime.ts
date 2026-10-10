//! emitted-lacks: bindHolder
//! emitted-lacks: bindReceiver
//! emitted-has: next.callWithReceiver(gea::NativeCallReceiver::object(gea_protocol_holder)
// The literal's methods are stored unbound and each protocol step calls them
// with the holder as the logical receiver: no bound callable is allocated per
// method, and no holder <-> bound-method cycle needs a weak edge to break.
// A database client's `onData`: a hand-written
// object literal typed `AsyncGenerator<Buffer>` whose `next` returns a
// `Promise` of one arm of `IteratorResult<T>` (a fresh `{ value, done: false }`
// or the shared `{ value: undefined, done: true }`) from some branches and a
// pending `Promise<IteratorResult<T>>` from another, then consumed by
// `for await`. Its `[Symbol.asyncIterator]() { return this }` reads the
// cursor carrier `AsyncGenerator<string>` names out of the literal's own
// record: a view whose steps call the SAME object's `next`/`return`/`throw`,
// so `break` closes it through `return()` and `throw(e)` reaches its own
// `throw` -- `Connection.dataEvents?.throw(error)`.
function promiseWithResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>(function withResolversExecutor(promiseResolve, promiseReject) {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject } as const
}

type PendingPromise = { resolve: (value: IteratorResult<string>) => void; reject: (reason: Error) => void }

function onData(first: string) {
  const unconsumedEvents: string[] = []
  const unconsumedPromises: PendingPromise[] = []
  let error: Error | null = null
  let finished = false

  const iterator: AsyncGenerator<string> & AsyncDisposable = {
    next() {
      const value = unconsumedEvents.shift()
      if (value != null) {
        return Promise.resolve({ value, done: false })
      }
      if (error != null) {
        const p = Promise.reject(error)
        error = null
        return p
      }
      if (finished) return closeHandler()
      const { promise, resolve, reject } = promiseWithResolvers<IteratorResult<string>>()
      unconsumedPromises.push({ resolve, reject })
      return promise
    },

    return() {
      return closeHandler()
    },

    throw(err: Error) {
      errorHandler(err)
      return Promise.resolve({ value: undefined, done: true })
    },

    [Symbol.asyncIterator]() {
      return this
    },

    async [Symbol.asyncDispose]() {
      await closeHandler()
    }
  }

  function eventHandler(value: string) {
    const promise = unconsumedPromises.shift()
    if (promise != null) promise.resolve({ value, done: false })
    else unconsumedEvents.push(value)
  }

  function errorHandler(err: Error) {
    const promise = unconsumedPromises.shift()
    if (promise != null) promise.reject(err)
    else error = err
    void closeHandler()
  }

  function closeHandler() {
    finished = true
    const doneResult = { value: undefined, done: finished } as const
    for (const promise of unconsumedPromises) {
      promise.resolve(doneResult)
    }
    return Promise.resolve(doneResult)
  }

  unconsumedEvents.push(first)
  return { iterator, eventHandler, closeHandler }
}

// The body schedules the next delivery as a job, so the loop's following
// `next()` is the pending branch and the job settles the promise it returned.
const main = async (): Promise<void> => {
  const source = onData('alpha')
  let round = 0
  for await (const message of source.iterator) {
    console.log(`message:${message}`)
    round++
    if (round === 1) void Promise.resolve().then(() => source.eventHandler('beta'))
    else if (round === 2) {
      source.eventHandler('gamma')
      source.eventHandler('delta')
    } else if (round === 4) void Promise.resolve().then(() => source.closeHandler())
  }
  const { iterator: early } = onData('one')
  for await (const message of early) {
    console.log(`early:${message}`)
    break
  }
  const settled = await early.next()
  console.log(`after-return:${settled.done}`)
  const events: AsyncGenerator<string> = onData('head').iterator
  const head = await events.next()
  console.log(`head:${head.value}`)
  const thrown = await events.throw(new Error('boom'))
  console.log(`thrown:${thrown.done}`)
  try {
    await events.next()
    console.log('no-error')
  } catch (error) {
    console.log(`rejected:${(error as Error).message}`)
  }
}
main()
//! expect: message:alpha
//! expect: message:beta
//! expect: message:gamma
//! expect: message:delta
//! expect: early:one
//! expect: after-return:true
//! expect: head:head
//! expect: thrown:true
//! expect: rejected:boom
