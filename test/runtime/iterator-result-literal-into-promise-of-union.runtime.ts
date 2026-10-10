// A database client's `onData` hand-writes an
// async iterator's `next()`: `Promise.resolve({ value, done: false })` from one
// branch, a pending `Promise<IteratorResult<T>>` from another, and
// `Promise.resolve(doneResult)` for `{ value: undefined, done: true } as
// const`. Three separate gaps stood between that and a native program:
//
// 1. A `Promise<{ value, done }>` returned where `Promise<IteratorResult<T>>`
//    is declared adopts the source's state with its payload converted -- and
//    `IteratorResult`'s arms are named interfaces a literal reaches only by a
//    structural record VIEW, which the ctx-free chain the promise step asked
//    cannot see. Must stay a live link, not a snapshot: the pending branch's
//    promise settles long after the conversion ran.
// 2. `{ value: undefined, done: true }` fitted the YIELD arm by carriers: the
//    chain admits `undefined` into `string` as `never`'s dead branch, and the
//    view took it, so the arm was built over `unreachableValue` and aborted.
// 3. With `T = any` (the client's `Buffer` derives to `any`) both arms take any
//    record by layout, since boolean literals do not survive structural
//    normalization. The arm is chosen at runtime from the record's own `done`.
//
// And the resolver: `resolve`'s parameter is `T | PromiseLike<T>`, flattened
// by TypeScript into one union when `T` is itself a union, so a resolver
// handed an ARM of `T` has to re-tag it at `T`'s own position.
function promiseWithResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>(function withResolversExecutor(promiseResolve, promiseReject) {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject } as const
}

interface TextSource {
  next(): Promise<IteratorResult<string>>
  return(): Promise<IteratorResult<string>>
}

interface AnySource {
  next(): Promise<IteratorResult<any>>
  return(): Promise<IteratorResult<any>>
}

function onText(first: string) {
  const unconsumedEvents: string[] = [first]
  const unconsumedPromises: { resolve: (value: IteratorResult<string>) => void }[] = []
  let finished = false

  const iterator: TextSource = {
    next() {
      const value = unconsumedEvents.shift()
      if (value != null) return Promise.resolve({ value, done: false })
      if (finished) return closeHandler()
      const { promise, resolve } = promiseWithResolvers<IteratorResult<string>>()
      unconsumedPromises.push({ resolve })
      return promise
    },
    return() {
      return closeHandler()
    }
  }

  function eventHandler(value: string) {
    const promise = unconsumedPromises.shift()
    if (promise != null) promise.resolve({ value, done: false })
    else unconsumedEvents.push(value)
  }

  function closeHandler() {
    finished = true
    const doneResult = { value: undefined, done: finished } as const
    for (const promise of unconsumedPromises) promise.resolve(doneResult)
    return Promise.resolve(doneResult)
  }

  return { iterator, eventHandler }
}

// `IteratorResult<any>`: both arms hold `value: any`.
function onAny(first: number) {
  const unconsumedEvents: number[] = [first]
  const unconsumedPromises: { resolve: (value: IteratorResult<any>) => void }[] = []
  let finished = false

  const iterator: AnySource = {
    next() {
      const value = unconsumedEvents.shift()
      if (value != null) return Promise.resolve({ value, done: false })
      if (finished) return closeHandler()
      return new Promise<IteratorResult<any>>((resolve) => {
        unconsumedPromises.push({ resolve })
      })
    },
    return() {
      return closeHandler()
    }
  }

  function eventHandler(value: number) {
    const promise = unconsumedPromises.shift()
    if (promise != null) promise.resolve({ value, done: false })
    else unconsumedEvents.push(value)
  }

  function closeHandler() {
    finished = true
    const doneResult = { value: undefined, done: finished } as const
    for (const promise of unconsumedPromises) promise.resolve(doneResult)
    return Promise.resolve(doneResult)
  }

  return { iterator, eventHandler }
}

const main = async (): Promise<void> => {
  const typed = onText('alpha')
  const first = await typed.iterator.next()
  console.log(`typed:${first.done ? 'done' : first.value}`)
  const pending = typed.iterator.next()
  typed.eventHandler('beta')
  const second = await pending
  console.log(`typed:${second.done ? 'done' : second.value}`)
  const closing = typed.iterator.next()
  void typed.iterator.return()
  const third = await closing
  console.log(`typed:${third.done ? 'done' : third.value}`)
  const after = await typed.iterator.next()
  console.log(`typed:${after.done ? 'done' : after.value}`)

  const loose = onAny(7)
  const one = await loose.iterator.next()
  console.log(`any:${one.done ? 'done' : one.value + 1}`)
  const waiting = loose.iterator.next()
  loose.eventHandler(41)
  const two = await waiting
  console.log(`any:${two.done ? 'done' : two.value + 1}`)
  const ending = loose.iterator.next()
  void loose.iterator.return()
  const three = await ending
  console.log(`any:${three.done ? 'done' : three.value}`)
}
main()
//! expect: typed:alpha
//! expect: typed:beta
//! expect: typed:done
//! expect: typed:done
//! expect: any:8
//! expect: any:42
//! expect: any:done
