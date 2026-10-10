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

const emitter = new Emitter()
const first = onData(emitter)
const second = onData(emitter)
emitter.emit('a')
emitter.emit('b')
//! expect: value a|value b|wait
console.log([first.next(), first.next(), first.next()].join('|'))
//! expect: listeners 2
console.log('listeners ' + emitter.listeners.length)
//! expect: closed after 2
console.log(first.ret())
//! expect: listeners 1
console.log('listeners ' + emitter.listeners.length)
emitter.emit('c')
//! expect: done
console.log(first.next())
//! expect: value a|value b|value c
console.log([second.next(), second.next(), second.next()].join('|'))
//! expect: failed boom
console.log(second.fail('boom'))
//! expect: error boom
console.log(second.next())
//! expect: listeners 0
console.log('listeners ' + emitter.listeners.length)

// Two calls never share a frame: each has its own counters.
const third = onData(emitter)
const fourth = onData(emitter)
emitter.emit('x')
//! expect: value x/value x
console.log(third.next() + '/' + fourth.next())
//! expect: closed after 1/wait
console.log(third.ret() + '/' + fourth.next())
