// A LIGHTWEIGHT SUBCLASS THAT OVERRIDES ITS BASE'S ACCESSORS AND KEEPS ITS
// STATE ON SYMBOL KEYS.
//
// This is the shape `@hono/node-server`'s `requestPrototype` expresses through
// prototype surgery -- an object whose `[[Prototype]]` is set to
// `Request.prototype`, whose members are installed with `Object.defineProperty`
// and whose instances are minted with `Object.create` -- written as the class
// the language has for it. The base's members must be ACCESSORS for a subclass
// to override them at all (a data property cannot be overridden by a getter),
// and the derived class computes its own lazily out of state nobody else names.

class BaseRequest {
  private url_: string = ''
  private headers_: string = ''
  private bodyUsed_: boolean = false

  constructor(url: string) {
    this.url_ = url
  }

  get url(): string {
    return this.url_
  }
  set url(value: string) {
    this.url_ = value
  }

  get headers(): string {
    return this.headers_
  }
  set headers(value: string) {
    this.headers_ = value
  }

  get bodyUsed(): boolean {
    return this.bodyUsed_
  }
  set bodyUsed(value: boolean) {
    this.bodyUsed_ = value
  }

  text(): Promise<string> {
    this.bodyUsed_ = true
    return Promise.resolve('base:' + this.url_)
  }
}

const incomingKey = Symbol('incoming')
const headersKey = Symbol('headers')
const cacheKey = Symbol('cache')
const consumedKey = Symbol('consumed')

class LightRequest extends BaseRequest {
  [incomingKey]: string;
  [headersKey]: string | undefined;
  [cacheKey]: BaseRequest | undefined;
  [consumedKey]: boolean

  constructor(incoming: string, url: string) {
    super(url)
    this[incomingKey] = incoming
    this[consumedKey] = false
  }

  // Built once, on first read, out of the connection the instance holds.
  override get headers(): string {
    return (this[headersKey] ||= 'from:' + this[incomingKey])
  }

  override get bodyUsed(): boolean {
    return this[consumedKey] || (this[cacheKey] !== undefined && this[cacheKey].bodyUsed)
  }

  private cache(): BaseRequest {
    return (this[cacheKey] ||= new BaseRequest(this.url))
  }

  override text(): Promise<string> {
    this[consumedKey] = true
    return Promise.resolve('light:' + this[incomingKey])
  }

  cachedText(): Promise<string> {
    return this.cache().text()
  }
}

const request = new LightRequest('socket-7', 'http://example.test/x')

//! expect: url=http://example.test/x
console.log('url=' + request.url)

//! expect: headers=from:socket-7
console.log('headers=' + request.headers)

//! expect: used-before=false
console.log('used-before=' + request.bodyUsed)

//! expect: text=light:socket-7
console.log('text=' + (await request.text()))

//! expect: used-after=true
console.log('used-after=' + request.bodyUsed)

// Read through the base's own declared type: the override still answers.
const asBase: BaseRequest = new LightRequest('socket-9', 'http://example.test/y')
//! expect: base-headers=from:socket-9
console.log('base-headers=' + asBase.headers)
//! expect: base-text=light:socket-9
console.log('base-text=' + (await asBase.text()))
