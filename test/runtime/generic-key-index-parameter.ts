//! expect: b 1 undefined b 7
// `T[K]` where only the INDEX is the type parameter: the object is a plain
// interface, and each copy binds `K` to the key it was called with (the
// value-use copy reads the constraint, a union of literal keys the checker
// evaluated from a conditional). tsc's `readPackageJsonField<K extends
// MatchingKeys<PackageJson, string | undefined>>(json, fieldName: K)`.
interface Fields {
  a?: string
  b?: string
  n?: number
}
type MatchingKeys<TRecord, TMatch, K extends keyof TRecord = keyof TRecord> = K extends (TRecord[K] extends TMatch ? K : never) ? K : never
function readString<K extends MatchingKeys<Fields, string | undefined>>(o: Fields, key: K): Fields[K] | undefined {
  return o[key]
}
function readAny<K extends keyof Fields>(o: Fields, key: K): Fields[K] {
  return o[key]
}
const o: Fields = { b: 'b', n: 1 }
const pick = (key: 'a' | 'b'): string | undefined => readString(o, key)
console.log(readString(o, 'b'), readAny(o, 'n'), readString(o, 'a'), pick('b'), (readAny(o, 'n') ?? 0) + 6)
