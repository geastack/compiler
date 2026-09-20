// hono's `Hono extends HonoBase`: the base's `#addRoute` is called from an
// arrow inside a base method (`args.forEach((h) => this.#addRoute(...))`),
// which reads the private method as a value on the DERIVED instance. That
// read walks the instance's method-state chain for the base class's
// evaluation, so the derived class's evaluation must link the base's state
// as its parent whatever representation the `extends` operand carries.
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
class Derived extends Base {
  constructor() {
    super()
  }
}
const app = new Derived()
app.on(
  'GET',
  (s) => s.toUpperCase(),
  (s) => s + '!'
)
console.log(app.run('hi'))
//! expect: GET=HI,GET=hi!
