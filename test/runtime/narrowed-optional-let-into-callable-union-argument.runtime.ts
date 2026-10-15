//! expect: fired: listen-a,listen-b,loop-2
//! expect: counts: 1,0,1,1
//! expect: absent: none

// node:net's `Server.listen` shape: a `let` annotated `T | undefined` with no
// initializer, written on some paths, then read under a truthiness guard into
// a parameter typed as a union of callables. The annotation already states the
// initial absence, so the guarded read is the narrowed callable and needs no
// conversion out of an optional.

type Handler = (...args: unknown[]) => void
type Named = (name: string) => void

class Emitter {
  private handlers: Handler[] = []
  once(listener: Handler | Named): number {
    this.handlers.push(listener as Handler)
    return this.handlers.length
  }
  emit(): void {
    const handlers = this.handlers
    this.handlers = []
    for (const handler of handlers) handler('listening')
  }
}

const fired: string[] = []

function listen(emitter: Emitter, first?: number | (() => void), second?: () => void): number {
  let listener: (() => void) | undefined
  if (typeof first === 'function') listener = first
  if (second) listener = second
  if (listener) return emitter.once(listener)
  return 0
}

function listenFromLoop(emitter: Emitter, names: string[]): number {
  let listener: (() => void) | undefined
  for (const name of names) {
    if (name.startsWith('loop')) listener = () => fired.push(name)
  }
  if (listener) return emitter.once(listener)
  return 0
}

function describe(listener: (() => void) | undefined): string {
  return listener ? 'some' : 'none'
}

function absentRead(flag: boolean): string {
  let listener: (() => void) | undefined
  if (flag) listener = () => fired.push('never')
  return describe(listener)
}

const emitter = new Emitter()
const counts = [
  listen(emitter, () => fired.push('listen-a')),
  listen(emitter, 1),
  listen(new Emitter(), 2, () => fired.push('unused')),
  listenFromLoop(new Emitter(), ['x', 'y'])
]
emitter.emit()
const second = new Emitter()
counts[2] = listen(second, 3, () => fired.push('listen-b'))
counts[3] = listenFromLoop(second, ['loop-1', 'x', 'loop-2']) - 1
second.emit()
console.log(`fired: ${fired.join(',')}`)
console.log(`counts: ${counts.join(',')}`)
console.log(`absent: ${absentRead(false)}`)
