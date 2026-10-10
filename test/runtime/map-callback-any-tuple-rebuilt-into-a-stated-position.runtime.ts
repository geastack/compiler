// Hono's RegExpRouter fills its static table with `staticMap[path] =
// [handlers.map(([h]) => [h, Object.create(null)]), emptyParam]`. The lib types
// `Object.create` as `any`, so the callback's tuple is `[T, any]` and its
// second slot is a box, while the table's stated position is
// `[T, ParamIndexMap][]`. The mapped array is unshared, so it is rebuilt into
// that position element by element, each element a live view of its `[T, any]`
// tuple -- and the view reads its source through the source's native field
// protocol, which the rebuild's ELEMENT conversion has to demand.
export {}

type ParamIndexMap = Record<string, number>
type Params = Record<string, string>
type Result<T> = [[T, ParamIndexMap][], string[]] | [[T, Params][]]

class Handler {
  constructor(readonly name: string) {}
}

const emptyParam: string[] = []

const build = <T>(handlers: [T, number][]): Record<string, Result<T>> => {
  const staticMap: Record<string, Result<T>> = Object.create(null)
  staticMap['/a'] = [handlers.map(([h]) => [h, Object.create(null)]), emptyParam]
  return staticMap
}

const table = build<Handler>([
  [new Handler('x'), 0],
  [new Handler('y'), 1]
])
const result = table['/a']!
const first = result[0][1]!
console.log(result[0].length, first[0].name, Object.keys(first[1]).length, result.length)
//! expect: 2 y 0 2
