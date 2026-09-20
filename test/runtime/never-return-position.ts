//! expect: 2 boom
// `return fail(...)`: a `never`-typed value in return position is an
// unreachable point, not a conversion into the function's result. tsc's
// `cast<TOut extends TIn, TIn>` ends in `return Debug.fail(...)`.
function fail(message: string): never {
  throw new Error(message)
}
interface Item {
  id: number
}
function cast(value: Item | undefined, ok: (value: Item) => boolean): Item {
  if (value !== undefined && ok(value)) return value
  return fail('boom')
}
let caught = 'none'
try {
  cast(undefined, () => true)
} catch (error) {
  caught = error instanceof Error ? error.message : 'other'
}
console.log(cast({ id: 2 }, () => true).id, caught)
