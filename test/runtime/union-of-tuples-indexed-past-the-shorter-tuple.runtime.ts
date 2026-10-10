// An HTTP framework's router `Result<T>` is `[[T, Params][]] | [[T, ParamIndexMap][],
// ParamStash]`, and `Context`'s param lookup reads `result[1]`, which the
// checker types `ParamStash | undefined` because it knows the first tuple has
// one element. The Array carrier keeps no length, so the one-element arm's
// element (a list of pairs) reached a read publishing `string[] | undefined`
// and the emitter refused the widening. That arm answers the absence the read
// publishes.
type Params = Record<string, string>
type Stash = string[]
type Result = [[string, Params][]] | [[string, Record<string, number>][], Stash]

const params: Params = {}
params['id'] = '7'
const indexMap: Record<string, number> = {}
indexMap['id'] = 0
const namedPair: [string, Params] = ['a', params]
const indexedPair: [string, Record<string, number>] = ['b', indexMap]
const namedHandlers: [string, Params][] = [namedPair]
const indexedHandlers: [string, Record<string, number>][] = [indexedPair]
const stash: Stash = ['42']
const named: Result = [namedHandlers]
const indexed: Result = [indexedHandlers, stash]

const paramOf = (result: Result, key: number): string | undefined => {
  const stash = result[1]
  return stash ? stash[key] : undefined
}

console.log(String(paramOf(named, 0)))
console.log(String(paramOf(indexed, 0)))
console.log(String(named.length) + ':' + String(indexed.length))

//! expect: undefined
//! expect: 42
//! expect: 1:2
