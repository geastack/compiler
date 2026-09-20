// A symbol-keyed class field declared WITHOUT an initializer, beside fields
// that have one, in a class that extends a base and assigns the field right
// after `super()`. Mirrors `@hono/node-server`'s adapted `LightRequest`:
// `[incomingKey]: IncomingMessage | Http2ServerRequest;`.
class Incoming {
  constructor(readonly url: string) {}
}
class IncomingTwo extends Incoming {
  constructor(url: string, readonly stream: number) {
    super(url)
  }
}
class BaseRequest {
  method = 'GET'
  constructor(readonly input: string) {}
}
const incomingKey = Symbol('incomingKey')
const headersKey = Symbol('headersKey')
const cacheKey = Symbol('cacheKey')

class LightRequest extends BaseRequest {
  [incomingKey]: Incoming | IncomingTwo;
  [headersKey]: string | undefined = undefined;
  [cacheKey]: boolean = false

  constructor(incoming: Incoming | IncomingTwo, method: string) {
    super('')
    this[incomingKey] = incoming
    this.method = method
  }

  get url(): string {
    return (this[headersKey] ||= this[incomingKey].url)
  }
}

const a = new LightRequest(new Incoming('/a'), 'POST')
const b = new LightRequest(new IncomingTwo('/b', 2), 'GET')
console.log(a.url, a.method, a[cacheKey])
console.log(b.url, b.method, b[incomingKey] instanceof IncomingTwo)
//! expect: /a POST false
//! expect: /b GET true
