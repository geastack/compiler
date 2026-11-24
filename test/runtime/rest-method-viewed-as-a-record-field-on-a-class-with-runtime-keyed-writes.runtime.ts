// A duplex stream inherits `emit` from an event emitter whose instances take
// writes under runtime string keys, so any string-keyed method may be shadowed
// by an own property living in the instance's expando table. Piping hands the
// stream on as a destination interface that carries `emit` among its methods:
// the view must read the own shadow when one exists and the inherited
// prototype method otherwise, and the call through it keeps the stream as its
// receiver.

export {}
type EventName = string | symbol
class Emitter {
  delivered = 0
  emit(name: EventName, ...args: readonly unknown[]): boolean {
    this.delivered += args.length
    return typeof name === 'string'
  }
}
class Duplex extends Emitter {
  chunks: unknown[] = []
  write(chunk: unknown): boolean {
    this.chunks.push(chunk)
    return true
  }
}
interface PipeDestination {
  write(chunk: unknown): boolean
  emit(name: EventName, ...args: readonly unknown[]): boolean
  notify?(name: 'pipe' | 'unpipe'): void
}
function tag(target: Emitter, key: string): void {
  // @ts-expect-error -- a runtime-keyed write
  target[key] = (name: EventName, ...args: readonly unknown[]): boolean => args.length > 99
}
class Sink {
  seen = 0
  write(chunk: unknown): boolean {
    this.seen += chunk === undefined ? 0 : 1
    return true
  }
  emit(name: EventName, ...args: readonly unknown[]): boolean {
    return args.length > 1 && typeof name === 'string'
  }
}
class Source {
  private targets: PipeDestination[] = []
  pipe<T>(destination: T): T {
    const target = destination as unknown as PipeDestination
    const onData = (chunk: unknown): void => {
      target.write(chunk)
    }
    this.targets.push(target)
    target.notify?.('pipe')
    onData('a')
    onData(2)
    return destination
  }
  unpipe(destination?: unknown): number {
    let removed = 0
    for (let index = this.targets.length - 1; index >= 0; index--) {
      if (destination !== undefined && this.targets[index] !== destination) continue
      this.targets.splice(index, 1)
      removed++
    }
    return removed
  }
  announce(): string {
    return this.targets.map((target) => target.emit('pipe', 1, 2)).join(',')
  }
}
const plain = new Duplex()
const tagged = new Duplex()
tag(tagged, Math.random() > 2 ? 'emit' : 'label')
const written: unknown[] = []
const literal: PipeDestination = {
  write(chunk: unknown): boolean {
    written.push(chunk)
    return false
  },
  emit(name: EventName, ...args: readonly unknown[]): boolean {
    return args.length === 2 && name === 'pipe'
  },
  notify(name: 'pipe' | 'unpipe'): void {
    written.push(name)
  }
}
const source = new Source()
source.pipe(plain)
source.pipe(tagged)
source.pipe(literal)
const sink = source.pipe(new Sink())
console.log(source.announce())
console.log(source.unpipe(sink), source.announce())
console.log(plain.delivered, plain.chunks.join(','), tagged.delivered, tagged.chunks.join(','), written.join(','), sink.seen)
//! expect: true,true,true,true
//! expect: 1 true,true,true
//! expect: 4 a,2 4 a,2 pipe,a,2 2
