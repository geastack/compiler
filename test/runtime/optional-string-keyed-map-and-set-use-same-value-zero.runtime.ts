// A `Map`/`Set` keyed by `string | undefined` -- a database client's
// `Map<string | undefined, ...>` of per-service connection pools. The key
// carrier is `gea::Optional<std::string>`, and keyed-collection lookup is
// SameValueZero (ECMA-262 7.2.12): `undefined` is one key, equal only to
// itself, and present keys compare as strings.
const pools = new Map<string | undefined, number>()
const pick = (flag: number): string | undefined => (flag > 1 ? 'svc-' + flag : undefined)
pools.set(pick(0), 1)
pools.set(pick(2), 2)
pools.set(pick(1), 3)
pools.set(pick(2), 4)
console.log(pools.size, pools.get(undefined), pools.get('svc-2'), pools.get('svc-3'), pools.has(pick(0)))
pools.delete(pick(1))
console.log(pools.size, pools.has(undefined))

const seen = new Set<string | undefined>()
seen.add(pick(3))
seen.add(pick(0))
seen.add(pick(3))
seen.add(undefined)
console.log(seen.size, seen.has(undefined), seen.has('svc-3'), seen.has('svc-4'))

const values = new Set<number | undefined>()
const nan = (flag: number): number | undefined => (flag > 0 ? 0 / 0 : undefined)
values.add(nan(1))
values.add(nan(1))
values.add(nan(0))
console.log(values.size, values.has(0 / 0), values.has(undefined))

//! expect: 2 3 4 undefined true
//! expect: 1 false
//! expect: 2 true true false
//! expect: 2 true true
