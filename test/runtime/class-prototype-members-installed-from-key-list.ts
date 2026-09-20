// PROTOTYPE MEMBERS INSTALLED FROM A LITERAL KEY LIST, ON A RE-PARENTED CLASS.
//
// `@hono/node-server`'s lightweight `Response` declares only the members it
// answers cheaply, re-parents its prototype onto the platform `Response`, and
// installs every other member with `Object.defineProperty` over a literal key
// list: each installed getter or method builds the real platform response and
// forwards to it. A read through the platform type must reach the installed
// member, never the platform's own, which would read state the lightweight
// construction never set.

class Platform {
  #status: number
  #statusText: string
  #text: string

  constructor(text: string, status: number) {
    this.#text = text
    this.#status = status
    this.#statusText = status === 200 ? 'OK' : 'Other'
  }

  get status(): number {
    return this.#status
  }

  get statusText(): string {
    return this.#statusText
  }

  text(): string {
    return this.#text
  }
}

var PlatformResponse: typeof Platform = Platform
const Captured = globalThis.PlatformResponse
const materialize = Symbol('materialize')

class Lite {
  #text: string
  #status: number

  constructor(text: string, status: number) {
    this.#text = text
    this.#status = status
  }

  [materialize](): Platform {
    return new Captured('full:' + this.#text, this.#status)
  }

  get status(): number {
    return this.#status
  }
}
;['statusText'].forEach((k) => {
  Object.defineProperty(Lite.prototype, k, {
    get() {
      return this[materialize]()[k]
    }
  })
})
;['text'].forEach((k) => {
  Object.defineProperty(Lite.prototype, k, {
    value: function () {
      return this[materialize]()[k]()
    }
  })
})

Object.setPrototypeOf(Lite, Captured)
Object.setPrototypeOf(Lite.prototype, Captured.prototype)

const make = (text: string, status: number): Platform => new Lite(text, status) as unknown as Platform

const lite = make('body', 200)

//! expect: status=200
console.log('status=' + lite.status)

//! expect: statusText=OK
console.log('statusText=' + lite.statusText)

//! expect: text=full:body
console.log('text=' + lite.text())

//! expect: platform=direct
console.log('platform=' + new Platform('direct', 404).text())
