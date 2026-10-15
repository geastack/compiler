// A generic method's parameter, instantiated at a class nothing constructs,
// asserted to an interface: node-compat's `pipeline()` narrows a destination
// with `instanceof Duplex` and hands it to `Readable.pipe<T>`, whose body views
// its `T` as the write surface (`destination as unknown as PipeDestination`).
// A program that constructs no `Duplex` (a test piping into a `Writable`) has
// no live view of that family to install, so the recast once refused the whole
// program. The arm cannot run with an object; the program must still compile
// and the reachable arm must still write through the view.
interface Destination {
  write(chunk: string): boolean
  end?(): void
}

class Stream {
  name: string
  constructor(name: string) {
    this.name = name
  }
}

class Source extends Stream {
  pipe<T>(destination: T): T {
    const target = destination as unknown as Destination
    target.write(this.name)
    if (typeof target.end === 'function') target.end()
    return destination
  }
}

class Sink extends Stream {
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  end(): void {
    console.log('sink=' + this.chunks.join(',') + ' name=' + this.name)
  }
}

// Never constructed: the `instanceof` arm below has no instance to run on.
class Both extends Source {
  seen = 0
  write(_chunk: string): boolean {
    this.seen++
    return true
  }
}

function connect(source: Source, destination: Sink | Both): string {
  if (destination instanceof Both) return 'both:' + source.pipe(destination).seen
  return 'sink:' + source.pipe(destination).chunks.length
}

console.log(connect(new Source('a'), new Sink('s')))
//! expect: sink=a name=s
//! expect: sink:1
export {}
