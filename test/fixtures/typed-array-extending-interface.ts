// An interface that EXTENDS a typed array must carry as that typed array.
//
// node declares `interface Buffer extends Uint8Array<ArrayBuffer>` and every
// library built on it -- bson, the mongodb driver -- relies on both halves of
// what TypeScript then says: a `Buffer` reaches `Uint8Array`'s own members, and
// a `Buffer` is accepted wherever a `Uint8Array` is declared. A carrier that
// answers only the second (or, as before, neither) makes `set`/`subarray`/
// `fill` into callable fields nothing defines.
interface Bytes extends Uint8Array<ArrayBuffer> {}

const total = (view: Uint8Array): number => {
  let sum = 0
  for (let index = 0; index < view.length; index += 1) sum += view[index] ?? 0
  return sum
}

const asBytes = (source: Uint8Array): Bytes => source as Bytes

const bytes: Bytes = asBytes(new Uint8Array(4))
bytes[0] = 3
bytes[1] = 4
// Both facts in one program: the extending name reaches the base's own
// members, and a value of it is accepted where the base is required.
console.log(`LEN:${bytes.length} SUM:${total(bytes)}`)
