// A database client reads server replies as `Document` --
// `{ [key: string]: any }` -- and hands them to parameters typed by a named
// interface: `new ServerError(document)` takes an `ErrorDescription`,
// which itself extends `Document`. The named fields are read out of the open
// document with a checked unbox, absent optional fields stay absent, and every
// other key survives in the interface's own index.
interface WireDocument {
  [key: string]: any
}

interface ErrorDescription extends WireDocument {
  message?: string
  errmsg?: string
  code?: number
}

interface Reply {
  ok: number
  n?: number
}

function describe(description: ErrorDescription): string {
  const extra = Object.keys(description)
    .filter((key) => key !== 'message' && key !== 'errmsg' && key !== 'code')
    .map((key) => `${key}=${description[key]}`)
  return `${description.errmsg ?? '-'}/${description.code ?? '-'}/${'message' in description}/${extra.join(',')}`
}

function replyStatus(reply: Reply): string {
  return `${reply.ok}:${reply.n ?? 'none'}`
}

const parsed: WireDocument = JSON.parse('{"ok":0,"errmsg":"not primary","code":10107,"codeName":"NotWritablePrimary"}')
console.log(describe(parsed))
const reply: WireDocument = JSON.parse('{"ok":1,"n":3}')
// @ts-expect-error the client's update operation's `handleOk` returns a `Document` as its result interface the same way
const failed: string = replyStatus(parsed)
// @ts-expect-error
console.log(failed, replyStatus(reply))
//! expect: not primary/10107/false/ok=0,codeName=NotWritablePrimary
//! expect: 0:none 1:3
