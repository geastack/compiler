//! expect: base data child:end
//! expect: own:end

// A call a dynamic write may shadow is dispatched virtually when a subclass
// overrides the method, and a virtual slot takes the family's widest
// parameters: `off(event: string)` under a base declaring
// `off(event: string | symbol)` is entered with the union. The shadow the
// call checks for first is handed those same converted arguments, so it must
// be read at the slot's convention -- read at the override's own, the union
// was passed where a string was expected and the program did not compile.

class Emitter {
  off(event: string | symbol): string {
    return 'base ' + String(event)
  }
}
class Stream extends Emitter {
  override off(event: string): string {
    return 'child:' + event
  }
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
const pick = (flag: boolean): Emitter => (flag ? new Stream() : new Emitter())
const plain = pick(false)
const stream = new Stream()
console.log(plain.off('data') + ' ' + stream.off('end'))
install(stream, 'off', (event: string) => 'own:' + event)
console.log(stream.off('end'))
export {}
