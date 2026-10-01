//! expect: 3 b
// A choice of two generic functions whose copies are reached ONLY through the
// set: nothing else allocates or calls `first`/`last`. The call runs each
// member's instantiated copy by name, so those copies must survive the
// reachability cut even though no `allocate-callable` cites them.
// light-my-request's `addAbortSignal(signal, this)` (a destructured generic
// from node-compat's `stream.ts`) is the same shape.
function first<T>(xs: T[]): T {
  return xs[0] as T
}
function last<T>(xs: T[]): T {
  return xs[xs.length - 1] as T
}
const pick = Math.random() > 2 ? first : last
console.log(pick([1, 2, 3]), pick(['a', 'b']))
