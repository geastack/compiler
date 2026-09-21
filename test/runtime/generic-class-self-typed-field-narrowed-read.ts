//! expect: fallback
//! expect: given
// hono's `Context.notFound`: a private field typed `NotFoundHandler<E>` -- a
// callable over `Context<E>`, which is `Context<E, any, BlankInput>` once the
// class's later parameters take their defaults -- defaulted with `??=` and
// then called with `this`, whose type is `Context<E, P, I>`. Two
// instantiations of ONE class declaration, so two structural shapes, and the
// nominal carrier is the same physical class either way: `representationKey`
// names a `class-ref` by its declaration alone, so the narrowed read of the
// defaulted field is the plain `optional(F) -> F` every other field gets.
//
// Deliberately sets the handler through a method rather than the constructor:
// a GENERIC class's written constructor body is dropped from the emitted
// `[[Construct]]` (`translation-unit.ts`'s `layout.constructor`), which is a
// separate defect and not what this program is here to hold.
class Rsp {
  constructor(readonly body: string) {}
}
type NotFound<E = unknown> = (c: Ctx<E>) => Rsp | Promise<Rsp>

class Ctx<E, P extends string = string, I extends object = object> {
  #notFoundHandler: NotFound<E> | undefined
  path: P | undefined
  input: I | undefined
  setNotFound(handler: NotFound<E>): void {
    this.#notFoundHandler = handler
  }
  notFound = (): ReturnType<NotFound> => {
    this.#notFoundHandler ??= () => new Rsp('fallback')
    return this.#notFoundHandler(this)
  }
}

const settled = async (produced: Rsp | Promise<Rsp>): Promise<string> => (produced instanceof Rsp ? produced : await produced).body

const main = async (): Promise<void> => {
  const bare = new Ctx<string, '/here', { seen: number }>()
  console.log(await settled(bare.notFound()))
  const given = new Ctx<string, '/there', { seen: number }>()
  given.setNotFound(() => new Rsp('given'))
  console.log(await settled(given.notFound()))
}
void main()
