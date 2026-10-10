// A tuple literal annotated `readonly [string, Direction]` and passed where a
// union also admits `ReadonlyArray<string>` -- a database client's `Sort` -- keeps its
// tuple layout.
type Direction = 1 | -1 | { readonly $meta: string }
type Sort = string | ReadonlyArray<string> | readonly [string, Direction]

function isPair(t: Sort): t is readonly [string, Direction] {
  if (Array.isArray(t) && t.length === 2) {
    return typeof t[1] === 'number' || typeof t[1] === 'object'
  }
  return false
}

const describe = (sort: Sort): string => {
  if (typeof sort === 'string') return `field ${sort}`
  if (isPair(sort)) return `guarded ${sort[0]}`
  const second = sort[1]
  return typeof second === 'number' ? `pair ${sort[0]} ${second}` : `list ${sort.length}`
}
const pair: readonly [string, Direction] = ['a', -1]
const strings: ReadonlyArray<string> = ['x', 'y', 'z']
console.log(describe(pair), describe(strings), describe('f'))

//! expect: guarded a list 3 field f
