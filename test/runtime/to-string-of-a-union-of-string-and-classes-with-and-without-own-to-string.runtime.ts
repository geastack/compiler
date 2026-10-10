// `String(input)` over WHATWG's `RequestInfo` -- `string | URL | Request` --
// is node-compat's `new Request(input)`: the string arm is itself, the class
// arm runs its own `toString` (7.1.17 -> 7.1.1.1 OrdinaryToPrimitive), and
// the arm that declares none is the "[object Object]" tag.
//
// A connection-string helper library's `ConnectionString extends URL` overrides
// `toString`, so the URL arm's method is not one body: 7.1.1.1 step 5.b.i
// looks the method up on the ALLOCATED object, and a `ConnectionString` held
// as a `URL` must run its own. `x.toString()` over a union already dispatched
// through the family's virtual member; `String(x)` refused ("no bound-method
// call site") because it asked the ToString table without that member.
class Locator {
  constructor(readonly href: string) {}
  toString(): string {
    return this.href
  }
}

class RedactedLocator extends Locator {
  override toString(): string {
    return 'redacted'
  }
}

class Envelope {
  constructor(readonly target: string) {}
}

class Fetcher {
  readonly url: string
  constructor(input: string | Locator | Envelope) {
    this.url = String(input)
  }
}

const describe = (locator: Locator): string => String(locator)

console.log(new Fetcher('plain').url)
console.log(new Fetcher(new Locator('http://x/')).url)
console.log(new Fetcher(new RedactedLocator('http://secret/')).url)
console.log(new Fetcher(new Envelope('e')).url)
console.log(describe(new RedactedLocator('http://y/')))
console.log(describe(new Locator('http://z/')))

//! expect: plain
//! expect: http://x/
//! expect: redacted
//! expect: [object Object]
//! expect: redacted
//! expect: http://z/
