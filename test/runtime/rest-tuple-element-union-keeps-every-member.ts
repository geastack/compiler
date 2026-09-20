//! expect: dispatch 5 1
// hono's `HonoBase.fetch` is a field whose DECLARED signature is
// `(request, Env?: E['Bindings'] | {}, executionCtx?: ExecutionContext) => ...`
// and whose implementation is `(request, ...rest) => ...`, so the checker
// types `rest` as the contextual tuple
// `[(E['Bindings'] | {})?, ExecutionContext?]`.
//
// Both of position 0's members are vacuous -- `{}` outright, and
// `E['Bindings']` through its constraint, since hono declares
// `type Bindings = object` -- so every object type is assignable to it and a
// `widestOf` join over the tuple's elements handed back position 0 alone.
// The rest array's element then named no `Execution` at all
// (`array-object(optional(dynamic | record{}))`), and `request(...)`
// forwarding a real one into it had no conversion.
//
// The spelling matters: `unknown | {}` reduces to `unknown` in the checker
// itself, and a bare `{}` alone derives to an empty record every object
// slices into, so only the deferred-indexed-access form holds the shape this
// exists to guard.
interface Execution {
  waitUntil(): void
}
type Bindings = object
interface Env {
  Bindings?: Bindings
}

class Dispatcher<E extends Env> {
  run: (path: string, bindings?: E['Bindings'] | {}, executionCtx?: Execution) => number = (path, ...rest) => {
    const context = rest[1]
    if (context !== undefined) context.waitUntil()
    return path.length + rest.length
  }

  request(path: string, bindings?: E['Bindings'] | {}, executionCtx?: Execution): number {
    return this.run(path, bindings, executionCtx)
  }
}

let waited = 0
const dispatcher = new Dispatcher<Env>()
console.log('dispatch', dispatcher.request('/ab', undefined, { waitUntil: () => void (waited += 1) }), waited)
