// `(cache || (cache = new Map())).set(k, v)` -- tsc's lazy-collection idiom
// (`createSymlinkCache`, `links.extendedContainersByFile`): the allocation is
// the right operand of an assignment nested in a `||` merge, and a callback
// `() => new Map()` whose contextual return type is the enclosing generic's
// `Map<K, V>`.
let cache: Map<string, number> | undefined
interface Links {
  byFile?: Map<number, string>
}
function remember(key: string, value: number): number {
  return (cache || (cache = new Map())).set(key, value).size
}
function extend(links: Links, id: number, name: string): number {
  ;(links.byFile || (links.byFile = new Map())).set(id, name)
  return links.byFile.size
}
const links: Links = {}
console.log(remember('a', 1), remember('b', 2), extend(links, 1, 'one'), extend(links, 2, 'two'), cache?.get('b'))
