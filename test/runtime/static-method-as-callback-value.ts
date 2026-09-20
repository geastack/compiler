// A method read off its class or instance as a VALUE and handed to a helper
// -- tsc's `formatGeneratedName(..., IdentifierNameMap.toKey)` -- is a plain
// callable: the object is only the path it was read through, and the body
// never reads `this`. The compiler materializes the value in the method's
// own receiver-first convention and binds the read's receiver in when the
// slot declares none (`CallableObject::bindReceiver`). One class is generic:
// its lifecycle events name the monomorphized copy, and the static call and
// the value read both have to find it censused.
//! expect: pre|name|suf 1 undefined
//! expect: ABC generic:alpha:1 generic:beta:undefined
//! expect: 2 4
class NameMap {
  private readonly entries = new Map<string, number>()
  static toKey(name: string): string {
    return name.toLowerCase()
  }
  set(name: string, value: number): void {
    this.entries.set(NameMap.toKey(name), value)
  }
  get(name: string): number | undefined {
    return this.entries.get(NameMap.toKey(name))
  }
}

class Store<V> {
  private readonly entries = new Map<string, V>()
  static toKey(name: string): string {
    return name.toLowerCase()
  }
  set(name: string, value: V): void {
    this.entries.set(Store.toKey(name), value)
  }
  get(name: string): V | undefined {
    return this.entries.get(Store.toKey(name))
  }
}

class Fmt {
  upper(name: string): string {
    return name.toUpperCase()
  }
  double(n: number): number {
    return n * 2
  }
}

function format(prefix: string, name: string, suffix: string, key: (name: string) => string): string {
  return key(prefix) + '|' + key(name) + '|' + key(suffix)
}

function apply(f: (s: string) => string, v: string): string {
  return f(v)
}

const map = new NameMap()
map.set('Alpha', 1)
console.log(format('Pre', 'Name', 'SUF', NameMap.toKey), map.get('ALPHA'), map.get('beta'))

const store = new Store<number>()
store.set('Alpha', 1)
const fmt = new Fmt()
console.log(apply(fmt.upper, 'abc'), 'generic:' + Store.toKey('ALPHA') + ':' + store.get('alpha'), 'generic:beta:' + store.get('beta'))

const twice: (n: number) => number = fmt.double
console.log([1, 2].map(twice).join(' '))
