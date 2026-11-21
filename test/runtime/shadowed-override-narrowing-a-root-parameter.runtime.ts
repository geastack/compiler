//! expect: stream a
//! expect: own b
//! expect: emitter c
//! expect: duplex d
// An override may narrow a parameter its family root declares wider: the
// root takes `string | symbol`, the subclass `string`. A call through the
// subclass converts its arguments into the root's convention for the virtual
// member, and a method a dynamic write installed over it must be called with
// those same arguments.

class Emitter {
  once(name: string | symbol, tag: string): string {
    return 'emitter ' + tag
  }
}
class Stream extends Emitter {
  override once(name: string, tag: string): string {
    return 'stream ' + tag
  }
}
class Duplex extends Stream {
  override once(name: string, tag: string): string {
    return 'duplex ' + tag
  }
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
const stream: Stream = new Stream()
console.log(stream.once('data', 'a'))
install(stream, 'once', (name: string, tag: string) => 'own ' + tag)
console.log(stream.once('data', 'b'))
const emitter: Emitter = new Emitter()
console.log(emitter.once(Symbol('end'), 'c'))
const duplex: Stream = new Duplex()
console.log(duplex.once('data', 'd'))
export {}
