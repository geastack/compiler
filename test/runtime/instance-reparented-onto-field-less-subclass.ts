// A live instance re-classed onto a field-less subclass that a mixin factory
// builds from the instance's own `.constructor` -- the shape
// a connection-string URL library's ConnectionString gives its searchParams.
//
// After the re-parent, calls through the base-typed field must reach the
// subclass overrides (both the one that calls `super` and the one that does
// not), `instanceof` must see the new class, and `.constructor` must be it.
// A second instance of the base that was never re-classed keeps its own
// methods, and a local instance can be re-classed as well.
//
//! expect: folded=true
//! expect: exact=true
//! expect: missing=false
//! expect: appended=lower:extra
//! expect: size=2
//! expect: plain=false
//! expect: local=true
//! expect: instance=true
//! expect: constructor=true
//! expect: plainInstance=false
class Params {
  private names: string[] = []

  append(name: string): void {
    this.names.push(name)
  }

  has(name: string): boolean {
    return this.names.indexOf(name) >= 0
  }

  size(): number {
    return this.names.length
  }

  last(): string {
    return this.names[this.names.length - 1] ?? ''
  }
}

function lower<K extends string = string>(Ctor: typeof Params) {
  return class LowerParams extends Ctor {
    has(name: K): boolean {
      return super.has(name.toLowerCase())
    }

    append(name: K): void {
      super.append('lower:' + name.toLowerCase())
    }
  }
}

class Holder {
  params: Params = new Params()

  constructor() {
    this.params.append('auth')
    Object.setPrototypeOf(this.params, lower(this.params.constructor as any).prototype)
  }
}

const holder = new Holder()
console.log('folded=' + holder.params.has('AUTH'))
console.log('exact=' + holder.params.has('auth'))
console.log('missing=' + holder.params.has('other'))
holder.params.append('EXTRA')
console.log('appended=' + holder.params.last())
console.log('size=' + holder.params.size())
const plain = new Params()
plain.append('auth')
console.log('plain=' + plain.has('AUTH'))
const local = new Params()
local.append('key')
const Lower = lower(Params)
Object.setPrototypeOf(local, Lower.prototype)
console.log('local=' + local.has('KEY'))
console.log('instance=' + (local instanceof Lower))
console.log('constructor=' + (local.constructor === Lower))
console.log('plainInstance=' + (plain instanceof Lower))
