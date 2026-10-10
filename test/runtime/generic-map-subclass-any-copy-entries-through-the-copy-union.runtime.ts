//! expect: ping
//! expect: rs0 100 0
//! expect: replicaset rs0
//! expect: maxpoolsize 100
//! expect: poolsize 0 true
// `Object.fromEntries(DEFAULT_OPTIONS.entries())` -- a database client's
// topology constructor. `CaseInsensitiveMap` is instantiated at `unknown`, `unknown[]`
// and its `any` default, so `DEFAULTS` is read as the union of the class's
// layout copies. `entries` is inherited from the native `Map` base: it is no
// declared member of the class, and the own-property sidecar the union read
// used to fall back to cannot see a native prototype member -- it answered
// `undefined`. Each arm now calls its native base's member on the arm viewed
// as that base; the `unknown[]` copy's map is walked through a read-only view
// that widens its values into the call's `[string, any]` pairs.
//
// node prints:
//   ping
//   rs0 100 0
//   replicaset rs0
//   maxpoolsize 100
//   poolsize 0 true
class CaseInsensitiveMap<Value = any> extends Map<string, Value> {
  constructor(entries: Array<[string, any]> = []) {
    super(entries.map(([k, v]) => [k.toLowerCase(), v]))
  }
  override get(k: string): Value | undefined {
    return super.get(k.toLowerCase())
  }
  override set(k: string, v: any) {
    return super.set(k.toLowerCase(), v)
  }
}

const DEFAULTS = new CaseInsensitiveMap([
  ['ReplicaSet', 'rs0'],
  ['MaxPoolSize', 100]
])
const counts = new CaseInsensitiveMap<unknown[]>()
const pool: unknown[] = []
counts.set('PoolSize', pool)
const objectOptions = new CaseInsensitiveMap<unknown>([['AppName', 'ping']])
console.log(objectOptions.get('APPNAME'))
const options = Object.fromEntries(DEFAULTS.entries())
console.log(options.replicaset, options.maxpoolsize, counts.get('POOLSIZE')?.length)
for (const [key, value] of DEFAULTS.entries()) console.log(key, value)
const dump = (map: CaseInsensitiveMap) => {
  for (const [key, value] of map.entries()) console.log(key, (value as unknown[]).length, map.has(key))
}
dump(counts)
