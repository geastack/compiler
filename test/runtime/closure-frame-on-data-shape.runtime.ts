// The shape of a database client's `onData`: two circular `List`s (sentinel head whose
// next and prev are itself) and an object-literal iterator, all captured by
// handlers that are registered on an emitter through a dynamically typed `on`
// and removed again by `off`, plus an abort listener that is a `this`-taking
// function and a formal (`emitter`) the handlers read. Each call builds a
// frame full of cycles and the collector reclaims them on a release; none may
// be reclaimed while still referenced. Meant to be run under the sanitizer.
type Pending = { resolve: (value: IteratorResult<string>) => void; reject: (reason: Error) => void }

interface ListNode<T> {
  next: ListNode<T> | null
  prev: ListNode<T> | null
  value: T | null
}

class List<T> {
  private readonly head: ListNode<T>
  private count: number
  constructor() {
    this.count = 0
    this.head = { next: null, prev: null, value: null }
    this.head.next = this.head
    this.head.prev = this.head
  }
  get length(): number {
    return this.count
  }
  push(value: T): void {
    this.count += 1
    const node: ListNode<T> = { next: this.head, prev: this.head.prev, value }
    this.head.prev!.next = node
    this.head.prev = node
  }
  shift(): T | null {
    const node = this.head.next!
    if (node === this.head) return null
    this.count -= 1
    this.head.next = node.next
    node.next!.prev = this.head
    return node.value
  }
  *[Symbol.iterator](): Generator<T, void, void> {
    let ptr = this.head.next!
    while (ptr !== this.head) {
      const next = ptr.next!
      yield ptr.value as T
      ptr = next
    }
  }
}

class Emitter {
  private handlers: { name: string; fn: (...args: any[]) => void }[] = []
  on(name: string, fn: (...args: any[]) => void): this {
    this.handlers.push({ name, fn })
    return this
  }
  off(name: string, fn: (...args: any[]) => void): this {
    this.handlers = this.handlers.filter((h) => h.name !== name || h.fn !== fn)
    return this
  }
  emit(name: string, ...args: any[]): void {
    for (const h of this.handlers.slice()) if (h.name === name) h.fn(...args)
  }
}

class Signal {
  private listeners: ((this: Signal) => void)[] = []
  reason = 'aborted'
  aborted = false
  addEventListener(fn: (this: Signal) => void): void {
    this.listeners.push(fn)
  }
  removeEventListener(fn: (this: Signal) => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn)
  }
  abort(): void {
    this.aborted = true
    for (const l of this.listeners.slice()) l.call(this)
  }
}

function addAbortListener(signal: Signal | undefined, listener: (this: Signal) => void): { dispose: () => void } | undefined {
  if (signal == null) return undefined
  signal.addEventListener(listener)
  return { dispose: () => signal.removeEventListener(listener) }
}

function onData(emitter: Emitter, signal?: Signal): AsyncGenerator<string> & AsyncDisposable {
  const unconsumedEvents = new List<string>()
  const unconsumedPromises = new List<Pending>()
  let error: Error | null = null
  let finished = false

  const iterator: AsyncGenerator<string> & AsyncDisposable = {
    next() {
      const value = unconsumedEvents.shift()
      if (value != null) return Promise.resolve({ value, done: false })
      if (error != null) {
        const p = Promise.reject(error)
        error = null
        return p
      }
      if (finished) return closeHandler()
      return new Promise<IteratorResult<string>>((resolve, reject) => {
        unconsumedPromises.push({ resolve, reject })
      })
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

  emitter.on('data', eventHandler)
  emitter.on('error', errorHandler)
  const abortListener = addAbortListener(signal, function (this: Signal) {
    errorHandler(new Error(this.reason))
  })
  return iterator

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

  function closeHandler(): Promise<IteratorResult<string>> {
    emitter.off('data', eventHandler)
    emitter.off('error', errorHandler)
    abortListener?.dispose()
    finished = true
    const doneResult = { value: undefined, done: finished } as const
    for (const promise of unconsumedPromises) promise.resolve(doneResult)
    return Promise.resolve(doneResult)
  }
}

function size(result: IteratorResult<string>): number {
  return result.done === true ? 0 : result.value.length
}

async function main(): Promise<void> {
  let seen = 0
  for (let round = 0; round < 4000; round++) {
    const emitter = new Emitter()
    const signal = round % 5 === 0 ? new Signal() : undefined
    const source = onData(emitter, signal)
    emitter.emit('data', 'a' + round)
    emitter.emit('data', 'bb')
    const first = await source.next()
    seen += size(first)
    const pending = source.next()
    const second = await pending
    seen += size(second)
    const waiting = source.next()
    emitter.emit('data', 'ccc')
    const third = await waiting
    seen += size(third)
    if (round % 7 === 0) {
      const more = source.next()
      if (signal !== undefined) signal.abort()
      else emitter.emit('error', new Error('boom'))
      try {
        await more
      } catch (e) {
        seen += 1000
      }
    }
    if (round % 3 === 0) await source.return(undefined)
    else await source[Symbol.asyncDispose]()
  }
  console.log('seen ' + seen)
}
main()
