//! expect: 1
//! expect: 2
// The free-function spelling of the overload set node-compat's
// `URLSearchParams` writes as a method: one bodiless signature declaring the
// result as an interface, one GENERATOR body. The callee already publishes the
// implementation's convention (`implementationSignatureOf`), so a call site
// reading the overload's `IterableIterator<number>` -- a native record ref --
// asked for a record from a callee whose convention returns an iterator, and
// cpp refused the conversion.
function counts(): IterableIterator<number>
function* counts(): Generator<number> {
  yield 1
  yield 2
}

for (const n of counts()) console.log(n)
