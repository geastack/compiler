// A frame holds closures whose environment is that frame, so each call builds a
// cycle. Calling the shape 100k times and dropping every result must leave a
// bounded number of live objects (hot-path-shapes.mjs asserts it after a full
// collection), whether the cycle closes on itself or runs through an emitter
// that also holds the listener.
// The shape of a database client's `onData`: several `let`s that closures share, and
// closures that capture each other. Every captured declaration of the call
// lives in ONE frame, so the call allocates that frame and a closure's
// environment is a handle to it, instead of one cell per variable and one
// environment block per closure.
//! emitted-has: _frame {
type Listener = (value: string) => void

class Emitter {
  listeners: Listener[] = []
  on(listener: Listener): void {
    this.listeners.push(listener)
  }
  off(listener: Listener): boolean {
    const index = this.listeners.indexOf(listener)
    if (index < 0) return false
    this.listeners.splice(index, 1)
    return true
  }
  emit(value: string): void {
    for (const listener of this.listeners.slice()) listener(value)
  }
}

interface Iter {
  next(): string
  ret(): string
  fail(reason: string): string
}

function onData(emitter: Emitter): Iter {
  let error: string | null = null
  let finished = false
  let count = 0
  const unconsumed: string[] = []
  const eventHandler: Listener = (value) => {
    unconsumed.push(value)
    count++
  }
  const errorHandler = (reason: string): void => {
    error = reason
    closeHandler()
  }
  const closeHandler = (): string => {
    finished = true
    emitter.off(eventHandler)
    return 'closed after ' + count
  }
  emitter.on(eventHandler)
  return {
    next: () => {
      if (error !== null) return 'error ' + error
      if (unconsumed.length > 0) return 'value ' + unconsumed.shift()
      return finished ? 'done' : 'wait'
    },
    ret: () => closeHandler(),
    fail: (reason) => {
      errorHandler(reason)
      return error === null ? 'none' : 'failed ' + error
    }
  }
}

let total = 0
for (let index = 0; index < 100000; index++) {
  const local = new Emitter()
  const iterator = onData(local)
  local.emit('v')
  total += iterator.next().length
  if (index % 2 === 0) total += iterator.ret().length
}
//! expect: total 1400000
console.log('total ' + total)
