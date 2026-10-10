// A connection-string URL library's ConnectionString, reduced: a live instance
// re-classed onto a subclass a mixin factory builds from its own
// `.constructor`, whose methods borrow another class's method with `.call`.
//
// Both roots compile natively:
//
// - `Object.setPrototypeOf(this.params, Mixin.prototype)` re-classes the live
//   `Params` onto the field-less mixin subclass (`ir/instance-reparenting.ts`),
//   so `holder.params.has(...)` reaches the case-insensitive override.
// - `CaseInsensitiveMap.prototype._normalizeKey.call(this, name)` runs a
//   `Map` subclass's method on a `Params` instance; the body is copied into
//   the mixin class and type-checked there, so `this.keys()` is `Params`'s
//   (`semantics/borrowed-method-receiver-copy-source-transform.ts`).
//
// `this.params.constructor as any` into the mixin's `typeof Params` parameter:
// `constructor-read-off-instance-into-family.ts`.
//
//! expect: exact=true
//! expect: folded=true
//! expect: missing=false
//! expect: plain=false
class Params {
  private names: string[] = []

  append(name: string): void {
    this.names.push(name)
  }

  has(name: string): boolean {
    return this.names.indexOf(name) >= 0
  }

  keys(): IterableIterator<string>
  *keys(): Generator<string> {
    for (let i = 0; i < this.names.length; i++) yield this.names[i]!
  }
}

class CaseInsensitiveMap<K extends string = string> extends Map<K, string> {
  _normalizeKey(name: any): K {
    name = `${name}`
    for (const key of this.keys()) {
      if (key.toLowerCase() === name.toLowerCase()) {
        name = key
        break
      }
    }
    return name
  }
}

function caseInsensitive<K extends string = string>(Ctor: typeof Params) {
  return class CaseInsensitiveParams extends Ctor {
    has(name: K): boolean {
      return super.has(this._normalizeKey(name))
    }

    _normalizeKey(name: K): string {
      return CaseInsensitiveMap.prototype._normalizeKey.call(this, name)
    }
  }
}

class Holder {
  params: Params = new Params()

  constructor() {
    this.params.append('authSource')
    Object.setPrototypeOf(this.params, caseInsensitive(this.params.constructor as any).prototype)
  }
}

const holder = new Holder()
console.log('exact=' + holder.params.has('authSource'))
console.log('folded=' + holder.params.has('AUTHSOURCE'))
console.log('missing=' + holder.params.has('replicaSet'))
console.log('plain=' + new Params().has('AUTHSOURCE'))
