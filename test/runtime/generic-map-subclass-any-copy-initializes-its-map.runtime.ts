// A generic class extending `Map` whose type parameter defaults to `any`,
// instantiated both at `any` and at a concrete type -- a database
// client's `class CaseInsensitiveMap<Value = any> extends Map<string, Value>`
// for connection-string options. The `any` copy is read as the family of its copies,
// and its own arm still carries the Map it extends, so its constructor's
// `super(entries)` initializes that Map.
class CaseInsensitiveMap<Value = any> extends Map<string, Value> {
  constructor(entries: Array<[string, any]> = []) {
    super(entries.map(([k, v]) => [k.toLowerCase(), v]))
  }
  override has(k: string): boolean {
    return super.has(k.toLowerCase())
  }
  override get(k: string): Value | undefined {
    return super.get(k.toLowerCase())
  }
}

const loose = new CaseInsensitiveMap([
  ['ReplicaSet', 'rs0'],
  ['TLS', true]
])
const counts = new CaseInsensitiveMap<unknown>([['PoolSize', 5]])
console.log(loose.has('replicaset'), loose.get('REPLICASET'), loose.get('tls'), loose.size)
console.log(counts.get('poolsize'), counts.has('POOLSIZE'), counts.size)

//! expect: true rs0 true 2
//! expect: 5 true 1
