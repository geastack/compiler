//! expect: v|k|7
//! expect: v2|k2|7
//! expect: a|1|7
//! expect: b|2|7
//! expect: A|1|7
//! expect: B|2|7
// `@hono/node-server` headers.ts: `RequestHeaders` derives from the captured
// `Headers` and OVERRIDES `forEach` with a wider callback, then forwards to the
// caller's own through `callback.call(thisArg, value, key, parent)`.
//
// Whether that forward is rewritten into a direct call of `callback` or has to
// reach `Function.prototype.call`'s own declared frame is a PROGRAM-WIDE fact
// (`semantics/callable-origins.ts`'s `callableBuiltinResolution`: any
// `Object.assign` onto a callable of unknown origin shadows the builtin
// everywhere). Both spellings have to work, and the second one is the one
// whose `this` slot is `(this: T, ...args: A) => R` with `A` inferred from the
// call site -- a closed TUPLE, not the open Array a rest adapter used to
// require.
class HeadersLite {
  count = 7
  names: string[] = []
  values: string[] = []
  add(key: string, value: string): void {
    this.names.push(key)
    this.values.push(value)
  }
  forEach(callback: (value: string, key: string) => void): void {
    for (let i = 0; i < this.names.length; i++) callback(this.values[i]!, this.names[i]!)
  }
}

const GlobalHeaders = HeadersLite
type GlobalHeaders = InstanceType<typeof GlobalHeaders>

type EachCallback = (value: string, key: string, parent: GlobalHeaders) => void

const forwardEach = (callback: EachCallback, thisArg: unknown, parent: GlobalHeaders): void => {
  callback.call(thisArg, 'v', 'k', parent)
}

const forwardApply = (callback: EachCallback, parent: GlobalHeaders): void => {
  callback.apply(undefined, ['v2', 'k2', parent])
}

class LazyHeaders extends GlobalHeaders {
  #native = new HeadersLite()
  override add(key: string, value: string): void {
    this.#native.add(key, value)
  }
  override forEach(callback: EachCallback, thisArg?: unknown): void {
    this.#native.forEach((value, key) => {
      callback.call(thisArg, value, key, this as unknown as GlobalHeaders)
    })
  }
}

const upper: EachCallback = (value, key, parent) => console.log(`${value.toUpperCase()}|${key}|${parent.count}`)
const plain: EachCallback = (value, key, parent) => console.log(`${value}|${key}|${parent.count}`)
const chosen = (which: boolean): EachCallback => (which ? upper : plain)

const headers = new HeadersLite()
forwardEach(plain, undefined, headers)
forwardApply(plain, headers)

const lazy = new LazyHeaders()
lazy.add('1', 'a')
lazy.add('2', 'b')
lazy.forEach((value, key) => console.log(`${value}|${key}|${lazy.count}`))
lazy.forEach(chosen(true))
