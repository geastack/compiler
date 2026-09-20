//! expect: plain:hello
//! expect: numbered:404
//! expect: inited:500

// hono's `Context.json: JSONRespond = <T, U>(object, arg?, headers?) => ...`
// (`context.ts`): the annotation is an interface of two GENERIC overloads that
// DISAGREE at parameter 1 (`U` in one, an object in the other), so no single
// convention joins out of the annotation -- while the value allocated is one
// generic arrow with one convention. `generic-field-initializer.ts` is the
// same shape whose two overloads happen to join; this one is the case where
// they do not, which is what left `c.json(...)` with a `callable-identity`
// callee and no invoke path.

interface JsonInit {
  code: number
}

interface JsonRespond {
  <U extends number = number>(object: string, status?: U, headers?: string): string
  <U extends number = number>(object: string, init?: JsonInit): string
}

class Ctx {
  json: JsonRespond = <U extends number = number>(object: string, arg?: U | JsonInit, _headers?: string): string => {
    if (typeof arg === 'number') return `numbered:${arg}`
    if (arg) return `inited:${arg.code}`
    return `plain:${object}`
  }
}

const ctx = new Ctx()
console.log(ctx.json('hello'))
console.log(ctx.json('hello', 404))
console.log(ctx.json('hello', { code: 500 }))
