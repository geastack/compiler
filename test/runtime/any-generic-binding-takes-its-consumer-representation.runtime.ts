// Hono's RegExpRouter declares `const nullMatcher: Matcher<any> = [/^$/, [],
// Object.create(null)]` and returns it from `buildMatcher<T>(): Matcher<T>`.
// The `any` positions are never read or written dynamically: the binding's one
// consumer wants `Matcher<T>`, so the binding is laid out as `Matcher<T>` from
// its initializer (empty containers have nothing to re-lay out) and the return
// is the identity -- no copy of a mutable container, no view, no box.
export {}

type ParamIndexMap = Record<string, number>
type HandlerData<T> = [T, ParamIndexMap][]
type Result<T> = [[T, ParamIndexMap][], string[]]
type StaticMap<T> = Record<string, Result<T>>
type Matcher<T> = [RegExp, HandlerData<T>[], StaticMap<T>]

class Route {
  constructor(readonly path: string) {}
}

const nullMatcher: Matcher<any> = [/^$/, [], Object.create(null)]

const buildMatcher = <T>(routes: readonly T[], paramIndex: ParamIndexMap): Matcher<T> => {
  if (routes.length === 0) return nullMatcher
  const handlerData: HandlerData<T>[] = [routes.map((route): [T, ParamIndexMap] => [route, paramIndex])]
  const staticMap: StaticMap<T> = Object.create(null)
  return [/^\/(\w+)$/, handlerData, staticMap]
}

const empty = buildMatcher<Route>([], {})
const full = buildMatcher<Route>([new Route('/a'), new Route('/b')], { id: 1 })
console.log(empty[0].test(''), empty[1].length, Object.keys(empty[2]).length)
const data = full[1][0]!
console.log(full[0].test('/x'), data.length, data[1]![0].path, data[0]![1]['id'])
console.log(buildMatcher<Route>([], {}) === empty)
//! expect: true 0 0
//! expect: true 2 /b 1
//! expect: true
