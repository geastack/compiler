// `x?.toString()` over `string | Address`: a cloud key-service request builds
// `new URL(options.url?.toString() ?? BASE_URL)` with `url?: string | URL`.
// The call dispatches on the arm the union holds -- String.prototype.toString
// for the string, the class's own method for the instance.

class Address {
  constructor(readonly href: string) {}
  toString(): string {
    return 'addr:' + this.href
  }
}

interface Options {
  url?: string | Address
}

function resolve(options: Options): string {
  return options.url?.toString() ?? 'default'
}

function direct(url: string | Address): string {
  return url.toString()
}

//! expect: default a addr:b
console.log(resolve({}) + ' ' + resolve({ url: 'a' }) + ' ' + resolve({ url: new Address('b') }))
//! expect: c addr:d
console.log(direct('c') + ' ' + direct(new Address('d')))
