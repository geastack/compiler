//! expect: / a
//! expect: /async b
// hono's handler slot is a UNION of two callable shapes -- `Handler` returning
// `R` and `MiddlewareHandler` returning `Promise<R | void>` -- and a call site
// infers `R` from the argument it is given. The checker COMBINES a union's two
// call signatures into one whose return is `R | Promise<R | void>`, so an
// async handler (`R` inferred as `Promise<Rsp>`) sees a contextual return of
// `Promise<Rsp> | Promise<void | Promise<Rsp>>`.
//
// An async body settles exactly one promise, so that sum is the slot's
// admission list, not this body's convention: published as the ABI result it
// left `return new Rsp(...)` with a `tagged-union` of two promises to settle
// into and no conversion for the pair.
class Rsp {
  constructor(readonly body: string) {}
}
interface TypedRsp<O> {
  readonly _data: O
  readonly _status: number
}
type Nxt = () => Promise<void>
type HandlerResponse<O> = Rsp | TypedRsp<O> | Promise<Rsp | TypedRsp<O>> | Promise<void>
type Handler<R extends HandlerResponse<unknown> = HandlerResponse<unknown>> = (c: number, next: Nxt) => R
type Middleware<R extends HandlerResponse<unknown> = Rsp> = (c: number, next: Nxt) => Promise<R | void>
type H<R extends HandlerResponse<unknown> = HandlerResponse<unknown>> = Handler<R> | Middleware<R>

const register = async <R extends HandlerResponse<unknown>>(path: string, handler: H<R>): Promise<void> => {
  const produced = await (handler as Handler<Rsp | Promise<Rsp>>)(1, async () => {})
  console.log(path, produced.body)
}

const main = async (): Promise<void> => {
  await register('/', (c) => new Rsp('a'))
  await register('/async', async (c) => new Rsp('b'))
}
void main()
