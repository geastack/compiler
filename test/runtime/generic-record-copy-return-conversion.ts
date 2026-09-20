// tsc moduleNameResolver.ts: `return toSearchResult(/*value*/ undefined)`
// inside a function returning `SearchResult<Resolved>`, where
// `toSearchResult<T>(value: T | undefined): SearchResult<T>` builds
// `{ value }`. The checker infers `T = undefined` at that call, so the copy's
// record is `{ value: undefined }` -- a different layout from the caller's
// `{ value: Resolved | undefined }` -- and the return asked for a conversion
// between two record layouts nothing installs (13 rows):
// `return-conversion:optional(record(T,owned,value:undefined;),undefined)->optional(record#T@h,undefined)`.
type SearchResult<T> = { value: T | undefined } | undefined
interface Resolved {
  path: string
  extension: string
}
function toSearchResult<T>(value: T | undefined): SearchResult<T> {
  return value !== undefined ? { value } : undefined
}
function resolveFrom(candidate: string, traceEnabled: boolean): SearchResult<Resolved> {
  if (candidate === '') {
    if (traceEnabled) console.log('empty candidate')
    return toSearchResult(/*value*/ undefined)
  }
  if (candidate.startsWith('..')) return toSearchResult(undefined)
  return toSearchResult<Resolved>({ path: candidate, extension: '.ts' })
}
const hit = resolveFrom('src/a', false)
const miss = resolveFrom('', true)
const up = resolveFrom('../x', false)
console.log(
  hit?.value?.path,
  hit?.value?.extension,
  miss === undefined ? 'none' : miss.value === undefined ? 'no-value' : 'value',
  up === undefined ? 'none' : 'some'
)
//! expect: empty candidate
//! expect: src/a .ts none none
