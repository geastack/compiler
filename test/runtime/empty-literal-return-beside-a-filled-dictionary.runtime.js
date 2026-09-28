// @ts-nocheck
//! dynamic-fallback
//! expect: 0 2 {"a":"1","b":"\"x\""}
// find-my-way's `getRouteMetaData`: `return {}` when nothing is asked, and
// otherwise the dictionary it filled by computed keys.
function metaOf (meta, keys) {
  if (!keys) return {}
  const filtered = {}
  for (const key of keys) {
    const value = meta[key]
    if (value !== undefined && value !== null) filtered[key] = JSON.stringify(value)
  }
  return filtered
}
const meta = { a: 1, b: 'x', c: null }
const none = metaOf(meta, null)
const some = metaOf(meta, ['a', 'b', 'c'])
console.log(Object.keys(none).length, Object.keys(some).length, JSON.stringify(some))
