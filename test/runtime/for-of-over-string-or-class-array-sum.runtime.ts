// `for`-`of` OVER `string[] | HostAddress[]` AFTER NORMALIZING A LONE SEED.
//
// A database client's `Topology` constructor takes `seeds: string |
// string[] | HostAddress | HostAddress[]`, rewraps a lone string or address
// into a one-element array, then walks `for (const seed of seeds)`: a string
// seed is parsed into a `HostAddress`, an address is kept as the same object.
// Each walk visits the live array's elements in order.

class HostAddress {
  constructor(
    readonly host: string,
    readonly port: number
  ) {}

  static fromString(text: string): HostAddress {
    const [host = 'localhost', port = '27017'] = text.split(':')
    return new HostAddress(host, Number(port))
  }

  toString(): string {
    return `${this.host}:${this.port}`
  }
}

function seedList(seeds: string | string[] | HostAddress | HostAddress[]): string {
  if (typeof seeds === 'string') {
    seeds = [HostAddress.fromString(seeds)]
  } else if (!Array.isArray(seeds)) {
    seeds = [seeds]
  }
  const seedlist: HostAddress[] = []
  for (const seed of seeds) {
    if (typeof seed === 'string') seedlist.push(HostAddress.fromString(seed))
    else if (seed instanceof HostAddress) seedlist.push(seed)
  }
  return seedlist.map((address) => address.toString()).join(',')
}

const kept = new HostAddress('db', 1)
//! expect: one=a:1 list=b:2,c:27017 address=db:1 addresses=db:1,e:5
console.log(
  `one=${seedList('a:1')} list=${seedList(['b:2', 'c'])} address=${seedList(kept)} addresses=${seedList([kept, new HostAddress('e', 5)])}`
)
