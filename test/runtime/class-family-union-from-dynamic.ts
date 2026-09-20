// AN `as`-ASSERTION FROM A DYNAMIC VALUE INTO A UNION OF TWO CLASSES, ONE OF
// WHICH DESCENDS FROM THE OTHER.
//
// `@hono/node-server`'s request helpers keep the connection on a symbol key of
// a `Record<string | symbol, any>` and read it back with
// `request[incomingKey] as IncomingMessage | Http2ServerRequest`. On this
// target `Http2ServerRequest extends IncomingMessage` (the shim in
// `node-compat/runtime/node/http2.ts` inherits the whole HTTP/1 member surface
// from it), so the two arms are not disjoint: every `Http2ServerRequest`
// allocation answers TRUE to the `IncomingMessage` nominal test as well.

class Incoming {
  complete: boolean
  constructor(complete: boolean) {
    this.complete = complete
  }
  describe(): string {
    return 'incoming'
  }
}

class Http2Incoming extends Incoming {
  authority: string
  constructor(authority: string) {
    super(true)
    this.authority = authority
  }
  override describe(): string {
    return 'http2:' + this.authority
  }
}

const incomingKey = Symbol('incoming')
const bag: Record<string | symbol, any> = {}

const readIncoming = (holder: Record<string | symbol, any>): Incoming | Http2Incoming => holder[incomingKey] as Incoming | Http2Incoming

bag[incomingKey] = new Incoming(false)
const plain = readIncoming(bag)
//! expect: plain=incoming complete=false
console.log('plain=' + plain.describe() + ' complete=' + plain.complete)

bag[incomingKey] = new Http2Incoming('example.test')
const upgraded = readIncoming(bag)
//! expect: upgraded=http2:example.test complete=true
console.log('upgraded=' + upgraded.describe() + ' complete=' + upgraded.complete)

// The narrowing the source performs on the union afterwards: the derived-only
// member is reachable only behind `instanceof`, exactly as `newRequest` reads
// `incoming.authority`.
//! expect: authority=example.test
if (upgraded instanceof Http2Incoming) {
  console.log('authority=' + upgraded.authority)
}

//! expect: plain-is-http2=false
console.log('plain-is-http2=' + (plain instanceof Http2Incoming))
