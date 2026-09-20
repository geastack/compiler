/**
 * `Map.prototype.set` / `Set.prototype.add` with an argument whose own type
 * is not already the collection's.
 *
 * `gea::mapSet(map, key, value)` deduced K and V from BOTH the map and the
 * arguments, so `m.set('a', 4)` on a `Map<string, number>` had no viable
 * overload at all: K deduced `std::string` from the map and `char[2]` from
 * the literal, V `double` from the map and `long long` from the integer the
 * argument narrowed to. Fail-closed rather than wrong, but a whole idiom's
 * worth of ordinary TypeScript with no emit -- and invisible until the
 * collection census started producing genuinely typed maps instead of boxed
 * ones. The collection decides K and V; an argument converts to them.
 */
const scores = new Map<string, number>()
scores.set('alpha', 4)
scores.set('beta', 9)

const seen = new Set<string>()
seen.add('alpha')

class Marker {
  constructor(readonly id: number) {}
}

const weakKey = new Marker(1)
const meta = new WeakMap<Marker, number>()
meta.set(weakKey, 16)

const marked = new WeakSet<Marker>()
marked.add(weakKey)

console.log(`${scores.get('alpha')},${scores.get('beta')},${seen.has('alpha')},${meta.get(weakKey)},${marked.has(weakKey)}`)
