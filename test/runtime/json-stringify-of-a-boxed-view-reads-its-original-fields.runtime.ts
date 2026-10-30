// A record passed as `Partial<W>` is a view that keeps the original. When the
// typed JSON writer cannot spell the view's fields (a union, a function), the
// call writes the view from its box, and the box reads each field of the
// original through the original's reflection hooks. The census published the
// call's argument, the view, but not the original it holds, so the original's
// field reads were pruned and the text was `{}`.
export {}

interface Mixed {
  id: string
  u: string | number
}
const mixed = (u: string | number): Mixed => ({ id: 'w', u })
const keepMixed = (v: Partial<Mixed>): Partial<Mixed> => v
//! expect: {"id":"w","u":1} {"id":"w","u":"s"}
console.log(JSON.stringify(keepMixed(mixed(1))), JSON.stringify(keepMixed(mixed('s'))))

interface Callable {
  id: string
  f: () => number
}
const callable = (): Callable => ({ id: 'c', f: () => 1 })
const keepCallable = (v: Partial<Callable>): Partial<Callable> => v
//! expect: {"id":"c"}
console.log(JSON.stringify(keepCallable(callable())))
