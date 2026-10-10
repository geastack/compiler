// A getter override declared `never` still completes: a connection-string parser's
// ConnectionString answers `get host(): never { return DUMMY as never }` over URL's
// string getter, and a read through the base type must reach that override.
const DUMMY = '__this_is_not_a_hostname__'

class Address {
  constructor(private readonly name: string) {}
  get host(): string {
    return this.name
  }
  port(): number {
    return 443
  }
}

abstract class AddressWithoutHost extends Address {
  abstract override get host(): never
}

class Masked extends AddressWithoutHost {
  hosts: string[] = ['a', 'b']
  override get host(): never {
    return DUMMY as never
  }
  override port(): never {
    throw new Error('masked addresses have no port')
  }
}

const describe = (address: Address): string => `${address.host.length}:${address.host}`
console.log(describe(new Address('example.com')))
console.log(describe(new Masked('ignored')))
const ports = (address: Address): string => {
  try {
    return String(address.port())
  } catch (error) {
    return (error as Error).message
  }
}
console.log(ports(new Address('a')), ports(new Masked('b')))
//! expect: 11:example.com
//! expect: 26:__this_is_not_a_hostname__
//! expect: 443 masked addresses have no port
export {}
