// A generic class constructed at `any` AND at a concrete filling, whose
// parameter reaches its storage only through members that hold no datum of
// that filling: an indexed access that is the top either way, a stored
// callable, and the class itself. An HTTP framework's `Context<E>`: `#dispatch` builds
// `new Context<any>` while every user handler is compiled for
// `Context<BlankEnv>`, and the program hands one to the other on every
// request. Splitting the two copies on the parameter's name alone left that
// hand-off with no conversion at all; they are one layout.
//
// The contrast case -- a parameter that IS stored data, which still splits --
// is `generic-map-subclass-any-copy-does-not-fold-into-array-copy.runtime.ts`.
type Env = { Bindings?: object; Variables?: object }
type BlankEnv = {}

type NotFound<E extends Env> = (c: Ctx<E>) => string

class Ctx<E extends Env = any> {
  env: E['Bindings'] = {}
  label: string
  #notFound: NotFound<E> | undefined
  set: (key: string, value: unknown) => void = (key, value) => {
    this.values.set(key, value)
  }
  values = new Map<string, unknown>()
  constructor(label: string, notFound?: NotFound<E>) {
    this.label = label
    this.#notFound = notFound
  }
  missing(): string {
    return this.#notFound ? this.#notFound(this) : `none:${this.label}`
  }
}

type Handler<E extends Env> = (c: Ctx<E>) => string

const dispatch = (handler: Handler<any>, label: string): string => {
  const c = new Ctx<any>(label, (inner) => `nf:${inner.label}`)
  c.set('k', label.length)
  return handler(c)
}

const own = new Ctx<BlankEnv>('own')
const user: Handler<BlankEnv> = (c) => `${c.label}:${String(c.values.get('k'))}:${c.missing()}`

console.log(dispatch(user, 'abc'))
console.log(user(own))

//! expect: abc:3:nf:abc
//! expect: own:undefined:none:own
