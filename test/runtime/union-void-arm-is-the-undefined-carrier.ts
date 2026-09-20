//! expect: ok
//! expect: none
//! expect: promise
//! expect: absent
// `T | void` and `T | undefined` are ONE carrier: a stored `void` is the
// `undefined` carrier (`primitives.ts`'s `storedCarrier` says so), so a union
// arm -- a stored position -- cannot read them differently.
//
// It did. `T | undefined` collapsed to `optional(T, undefined)` while
// `T | void` became `tagged-union(undefined | T)`, and hono's
// `defineWebSocketHelper` met both at once: the handler slot is
// `Response | void | Promise<Response | void>`, whose promise arm derived
// `promise(tagged-union(undefined | class-ref(Response)))`, while the async
// arrow the program passes returns `Promise<Response | undefined>` and
// derived `promise(optional(class-ref(Response), undefined))`. One carrier
// under two names has no conversion between them.
//
// The `instanceof Promise` below is the second half: the backend rendered
// that test over a `tagged-union` left operand and not over an `optional`
// one, so unifying the two spellings moved node-compat's
// `whatwg-streams.ts` (`const result = write(chunk, ...)`, typed
// `void | Promise<void>`, then `result instanceof Promise`) onto a renderer
// that did not exist.
class Rsp {
  constructor(readonly body: string) {}
}

type Handler = (flag: boolean) => Rsp | void | Promise<Rsp | void>

const handler: Handler = async (flag) => (flag ? new Rsp('ok') : undefined)

const invoke = async (fn: Handler, flag: boolean): Promise<string> => {
  const produced = await (fn as (flag: boolean) => Promise<Rsp | undefined>)(flag)
  return produced === undefined ? 'none' : produced.body
}

const maybePromise = (flag: boolean): void | Promise<Rsp> => (flag ? Promise.resolve(new Rsp('p')) : undefined)

const main = async (): Promise<void> => {
  console.log(await invoke(handler, true))
  console.log(await invoke(handler, false))
  console.log(maybePromise(true) instanceof Promise ? 'promise' : 'absent')
  console.log(maybePromise(false) instanceof Promise ? 'promise' : 'absent')
}
void main()
