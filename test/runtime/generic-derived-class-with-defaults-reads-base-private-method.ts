// hono's `class Hono<E = BlankEnv, S = BlankSchema, P = '/'> extends
// HonoBase<E, S, P>` constructed bare (`new Hono()`): a GENERIC derived class
// whose parameters all default. The `evaluate-heritage` event the census
// records for it must be the one the class's allocation lowering finds, or
// the derived evaluation allocates a method-state owner with no parent and
// the first base method read as a value on an instance aborts.
type Handler = (input: string) => string
class Base {
  #routes: [string, Handler][] = []
  #addRoute(method: string, handler: Handler): void {
    this.#routes.push([method, handler])
  }
  on(method: string, ...handlers: Handler[]): this {
    handlers.forEach((handler) => {
      this.#addRoute(method, handler)
    })
    return this
  }
  run(input: string): string {
    return this.#routes.map(([method, handler]) => method + '=' + handler(input)).join(',')
  }
}
class App<Tag extends string = 'app'> extends Base {
  tag: Tag | undefined
  constructor() {
    super()
  }
}
const app = new App()
app.on(
  'GET',
  (s) => s.toUpperCase(),
  (s) => s + '!'
)
console.log(app.run('hi'))
//! expect: GET=HI,GET=hi!
