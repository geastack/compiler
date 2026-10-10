// A native generator cursor returned where `IterableIterator<T>` is declared.
//
// A connection-string parser's case-insensitive `URLSearchParams`
// subclass overrides `keys()`/`values()`/`entries()` with `return
// super.keys() as IterableIterator<K>`. node-compat's `URLSearchParams`
// (`runtime/node/globals.ts`) implements each as a generator behind an
// `IterableIterator<T>` overload, so `super.keys()` is the native cursor while
// the override's own declared result is the interface. The override must hand
// back the SAME cursor: a step taken through either name advances both, and a
// later append is visible to a cursor already in flight.
class Params {
  private names: string[] = []
  private values_: string[] = []

  append(name: string, value: string): void {
    this.names.push(name)
    this.values_.push(value)
  }

  keys(): IterableIterator<string>
  *keys(): Generator<string> {
    for (let i = 0; i < this.names.length; i++) yield this.names[i]!
  }

  values(): IterableIterator<string>
  *values(): Generator<string> {
    for (let i = 0; i < this.values_.length; i++) yield this.values_[i]!
  }

  entries(): IterableIterator<[string, string]>
  *entries(): Generator<[string, string]> {
    for (let i = 0; i < this.names.length; i++) yield [this.names[i]!, this.values_[i]!]
  }
}

class Loud<K extends string = string> extends Params {
  keys(): IterableIterator<K> {
    return super.keys() as IterableIterator<K>
  }

  values(): IterableIterator<string> {
    return super.values()
  }

  entries(): IterableIterator<[K, string]> {
    return super.entries() as IterableIterator<[K, string]>
  }
}

const params = new Loud()
params.append('a', '1')
params.append('b', '2')

const keys = params.keys()
//! expect: self=true
console.log('self=' + (keys[Symbol.iterator]() === keys))
const first = keys.next()
//! expect: first=a false
console.log('first=' + first.value + ' ' + (first.done === true))
params.append('c', '3')
const rest: string[] = []
for (const key of keys) rest.push(key)
//! expect: rest=b,c
console.log('rest=' + rest.join(','))
const after = keys.next()
//! expect: after=true
console.log('after=' + (after.done === true))

const values: string[] = []
for (const value of params.values()) values.push(value)
//! expect: values=1,2,3
console.log('values=' + values.join(','))

const entries: string[] = []
for (const [key, value] of params.entries()) entries.push(key + '=' + value)
//! expect: entries=a=1,b=2,c=3
console.log('entries=' + entries.join(','))

const base: Params = params
const viaBase: string[] = []
for (const key of base.keys()) viaBase.push(key)
//! expect: base=a,b,c
console.log('base=' + viaBase.join(','))
