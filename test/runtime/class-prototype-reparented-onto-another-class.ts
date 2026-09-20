// A CLASS WHOSE PROTOTYPE IS RE-PARENTED ONTO ANOTHER CLASS'S PROTOTYPE.
//
// `@hono/node-server`'s `RequestHeaders` declares no `extends`, answers every
// `Headers` method itself from the incoming message, and then runs
// `Object.setPrototypeOf(RequestHeaders.prototype, GlobalHeaders.prototype)`
// so `request.headers instanceof Headers` holds. Its instances are handed out
// `as unknown as Headers` and used through that type.
//
// After the call the instance's chain is RequestHeaders.prototype ->
// Headers.prototype, so a method RequestHeaders declares answers first and
// one it does not comes from Headers -- running against an object that
// Headers' constructor never initialized. Here every Headers method that reads
// Headers' own state is overridden, and the one it does not override
// (`describe`) reaches that state only through the overridden methods.

class Store {
  private names: string[] = []
  private values: string[] = []

  get(name: string): string | null {
    const index = this.names.indexOf(name)
    return index < 0 ? null : this.values[index]!
  }

  set(name: string, value: string): void {
    this.names.push(name)
    this.values.push(value)
  }

  describe(name: string): string {
    return name + '=' + (this.get(name) ?? '-')
  }
}

var Platform: typeof Store = Store
const Captured = globalThis.Platform

class Lazy {
  #source: Record<string, string>

  constructor(source: Record<string, string>) {
    this.#source = source
  }

  get(name: string): string | null {
    return this.#source[name] ?? null
  }

  set(name: string, value: string): void {
    this.#source[name] = value
  }
}

Object.setPrototypeOf(Lazy.prototype, Captured.prototype)

const make = (source: Record<string, string>): Store => new Lazy(source) as unknown as Store

const view = make({ host: 'example' })

//! expect: get=example
console.log('get=' + view.get('host'))

view.set('accept', 'json')
//! expect: set=json
console.log('set=' + view.get('accept'))

//! expect: inherited=host=example
console.log('inherited=' + view.describe('host'))

//! expect: instanceof=true
console.log('instanceof=' + (view instanceof Platform))

//! expect: plain=platform-miss
console.log('plain=' + (new Platform().get('host') ?? 'platform-miss'))
