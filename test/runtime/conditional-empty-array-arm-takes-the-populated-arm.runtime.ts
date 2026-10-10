// Hono's RegExpRouter builds `const ownRoute = r[method] ?
// Object.keys(r[method]).map((path) => [path, r[method][path]]) : []`. The
// checker types the conditional as the populated arm's array (an empty literal
// is already a value of it), so the binding, the merge and the `[]` arm all
// share that one carrier: the empty literal is BUILT in it rather than merged
// as a second, element-less array arm the binding would have to select from.
export {}

class Handler {
  constructor(readonly name: string) {}
}

type Table = Record<string, Record<string, Handler[]>>

const collect = (tables: Table[], method: string): [string, Handler[]][] => {
  const routes: [string, Handler[]][] = []
  tables.forEach((r) => {
    const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method]![path]!]) : []
    if (ownRoute.length !== 0) routes.push(...(ownRoute as [string, Handler[]][]))
  })
  return routes
}

const routes = collect([{ GET: { '/a': [new Handler('a')], '/b': [new Handler('b'), new Handler('c')] } }, { POST: {} }, {}], 'GET')
console.log(routes.length, routes[0]![0], routes[1]![1].length, routes[1]![1][1]!.name)
console.log(collect([{}], 'GET').length)
//! expect: 2 /a 2 c
//! expect: 0
//! emitted-lacks: gea::ArrayObject<gea::Undefined>
