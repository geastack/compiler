// A static record spread into a literal whose type carries an index signature
// (a database client's `WriteConcernError`: `{ ...result.writeConcernError, ...result }`
// with `result: { ...; [x: string]: unknown }`). Every copied key lands in the
// literal's dictionary, so the copy runs as `CopyDataProperties`.
interface Result {
  inner: { code: number; errmsg: string }
  ok: number
  [x: string]: unknown
}
const describe = (message: { [key: string]: unknown }): string => `${message.code}/${message.errmsg}/${message.ok}/${message.extra}`
const result: Result = { inner: { code: 64, errmsg: 'wc' }, ok: 1, extra: 'x' }
console.log(describe({ ...result.inner, ...result }))
const merged: Result = { tag: 0, ...result, code: 7 }
console.log(merged.ok, merged.inner.errmsg, merged.code, merged.extra, merged.tag)
//! expect: 64/wc/1/x
//! expect: 1 wc 7 x 0
