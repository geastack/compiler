// ECMA-262 25.5.2.5 SerializeJSONObject: JSON.stringify of a class instance
// with no toJSON writes the instance's own enumerable string-keyed
// properties in creation order -- field definitions, base class first -- and
// skips members whose value is undefined or a function. Accessors and
// methods live on the prototype and are not own. A database client prints a
// HostAddress this way (`Unexpected HostAddress ${JSON.stringify(hostAddress)}`).

class HostAddress {
  host: string | undefined = undefined
  port: number | undefined = undefined
  socketPath: string | undefined = undefined
  isIPv6 = false
  constructor(host: string, port?: number) {
    if (host.endsWith('.sock')) {
      this.socketPath = host
      return
    }
    this.host = host
    this.port = port ?? 27017
  }
  get label(): string {
    return `${this.host}:${this.port}`
  }
  toString(): string {
    return this.label
  }
}

//! expect: {"host":"localhost","port":27017,"isIPv6":false}
console.log(JSON.stringify(new HostAddress('localhost')))
//! expect: {"socketPath":"/tmp/db.sock","isIPv6":false}
console.log(JSON.stringify(new HostAddress('/tmp/db.sock')))
//! expect: Unexpected HostAddress {"host":"db","port":1,"isIPv6":false}
console.log(`Unexpected HostAddress ${JSON.stringify(new HostAddress('db', 1))}`)

class Base {
  kind = 'base'
  tags: string[] = ['a', 'b']
}
class Derived extends Base {
  ratio = 0.5
  note: string | null = null
  inner = { deep: true }
}
//! expect: {"kind":"base","tags":["a","b"],"ratio":0.5,"note":null,"inner":{"deep":true}}
console.log(JSON.stringify(new Derived()))

class Pair {
  first = 1
  second = 'two'
}
//! expect: {"first":1,"second":"two"}
console.log(JSON.stringify(new Pair()))

class Holder {
  address: HostAddress | undefined
  pairs: Pair[] = []
  constructor(address: HostAddress | undefined) {
    this.address = address
    this.pairs.push(new Pair())
  }
}
//! expect: {"address":{"host":"h","port":2,"isIPv6":false},"pairs":[{"first":1,"second":"two"}]}
console.log(JSON.stringify(new Holder(new HostAddress('h', 2))))
//! expect: {"pairs":[{"first":1,"second":"two"}]}
console.log(JSON.stringify(new Holder(undefined)))

// A private name is a PrivateElement, not a property; an own function-valued
// field is skipped like any function; a key the program adds past the
// declared fields lives in the expando sidecar and follows them; a deleted
// field is no longer own.
class Mixed {
  #secret = 42
  visible = 'yes'
  callback = (): number => this.#secret
  count = 3
  reveal(): number {
    return this.#secret + this.callback()
  }
}
const mixed = new Mixed()
const loose = mixed as any
loose['extra'] = [1, 2]
//! expect: {"visible":"yes","count":3,"extra":[1,2]}
console.log(JSON.stringify(mixed))
delete loose['visible']
//! expect: {"count":3,"extra":[1,2]}
console.log(JSON.stringify(mixed))
//! expect: 84
console.log(mixed.reveal())
