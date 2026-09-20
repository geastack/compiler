/**
 * A collection cell the program lets go ABSENT, whose type arguments the
 * program never states -- three's `WebGLRenderer.js`:
 *
 *     let programs = materialProperties.programs;
 *     if ( programs === undefined ) { programs = new Map(); ... }
 *     programs.set( programCacheKey, program );
 *
 * `collection-bindings.ts` reads K off the `.set` call, so every read past
 * the `undefined` guard carries `keyed-collection(map, string, ...)`. The
 * DECLARATION's own type is a union, and the owner-keyed override refused a
 * union outright -- so the cell carried the uninformative K/V its initializer
 * came with while its reads carried the census's. Two authorities over one
 * storage, surfacing as an unsatisfiable `binding-read-conversion:optional(
 * keyed-collection@...)->keyed-collection(map,string,...)` at every read
 * rather than as an error anywhere: the `optional(T) -> T` the guard licenses
 * is installed, it just never applied, because the two `T`s were not the same
 * `T`.
 *
 * Runs rather than merely compiles, so the string keys and number values the
 * census inferred have to actually reach the map.
 */
const groups = new Map<string, Map<string, number>>()

function put(group: string, key: string, value: number): void {
  let entries = groups.get(group)
  if (entries === undefined) {
    entries = new Map()
    groups.set(group, entries)
  }
  entries.set(key, value)
}

function read(group: string, key: string): number {
  const entries = groups.get(group)
  if (entries === undefined) return -1
  const found = entries.get(key)
  return found === undefined ? -1 : found
}

put('a', 'alpha', 4)
put('a', 'beta', 9)
put('b', 'alpha', 16)
console.log(`${read('a', 'alpha')},${read('a', 'beta')},${read('b', 'alpha')},${read('c', 'alpha')}`)
