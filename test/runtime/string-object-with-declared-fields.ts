//! expect: raw true 1
//! expect: hello 5
// hono's `utils/html.ts`: `type HtmlEscapedString = string & HtmlEscaped`, and
// `raw()` mints one with `new String(value) as HtmlEscapedString`, then writes
// both declared fields onto it. `new String` is the WRAPPER OBJECT, so the
// fields have somewhere to live -- the native dynamic-property sidecar the
// printer's String-object interceptor owns.
//
// `interface String` declares `readonly [index: number]: string`, so the
// String-object carrier's layout has a NUMBER-keyed index sidecar. The slot
// census handed `isEscaped` that sidecar's `string` carrier anyway and then
// wanted a `scalar(boolean) -> string` conversion: a named key addresses no
// number index (ECMA-262 6.1.7 / Number::toString canonicalization), and the
// census now says so.
type EscapedCallback = (phase: number) => string
type Escaped = {
  isEscaped: true
  callbacks?: EscapedCallback[]
}
type EscapedString = string & Escaped

const raw = (value: string, callbacks?: EscapedCallback[]): EscapedString => {
  const escapedString = new String(value) as EscapedString
  escapedString.isEscaped = true
  escapedString.callbacks = callbacks
  console.log('raw', escapedString.isEscaped, (escapedString.callbacks ?? []).length)
  return escapedString
}

const wrapped = raw('hello', [(phase: number) => String(phase)])
console.log(String(wrapped), wrapped.length)
