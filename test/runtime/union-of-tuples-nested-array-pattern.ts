//! expect: /x
// The same union-of-tuples source, read through a NESTED pattern in a `.map`
// callback's parameter -- hono's `HonoRequest.routePath`, whose
// `Result<T> = [[T, ParamIndexMap][], ParamStash] | [[T, Params][]]` makes
// `matchResult[0]`'s element the union `[T, ParamIndexMap] | [T, Params]`.
type ParamIndexMap = Record<string, number>
type Params = Record<string, string>
interface Route {
  path: string
}
type MatchResult<T> = [[T, ParamIndexMap][], string[]] | [[T, Params][]]

const routePathOf = (matchResult: MatchResult<[number, Route]>, index: number): string =>
  matchResult[0].map(([[, route]]) => route)[index]!.path

const params: Params = {}
params['a'] = 'b'
const entry: [[number, Route], Params] = [[7, { path: '/x' }], params]
console.log(routePathOf([[entry]], 0))
