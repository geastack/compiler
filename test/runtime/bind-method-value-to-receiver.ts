// `host.readFile.bind(host)` -- tsc's `program.ts` binds a host's methods this
// way before handing them on. `Function.prototype.bind` is five ambient
// overloads, one per bound-argument arity, and a value cannot be five
// conventions: the read is whichever one this call resolved to.
//! expect: read:a.ts read:b.ts true
class Host {
  readonly prefix = 'read:'
  readFile(name: string): string {
    return this.prefix + name
  }
  realpath?: (path: string) => string
}

function readAll(read: (name: string) => string, first: string, second: string): string {
  return read(first) + ' ' + read(second)
}

const host = new Host()
const readFile = host.readFile.bind(host)
const realpath = host.realpath?.bind(host)
console.log(readAll(readFile, 'a.ts', 'b.ts'), realpath === undefined)
