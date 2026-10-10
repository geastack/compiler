// An implicit-any `let` with no initializer takes the union of what is assigned
// to it (TypeScript's evolving-let typing), not a dynamic carrier. A binary-document
// serializer's ObjectId constructor declares `let workingId;` and assigns it from a decoded
// Uint8Array, from an `id` property that is a string or a Uint8Array, or from
// the argument itself.
interface IdLike {
  id: string | Uint8Array
  tag?: string
}
function decode(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
function describe(input?: string | IdLike | Uint8Array): string {
  let working
  if (typeof input === 'object' && input && 'id' in input) {
    if (input.tag === 'hex' && typeof input.id === 'string') working = decode(input.id)
    else working = input.id
  } else {
    working = input
  }
  if (working == null) return 'none'
  if (working instanceof Uint8Array) return `bytes:${working.length}`
  return `string:${working}`
}
console.log(
  describe(),
  describe('abc'),
  describe(new Uint8Array(3)),
  describe({ id: 'xy' }),
  describe({ id: new Uint8Array(2) }),
  describe({ id: 'abcd', tag: 'hex' })
)

//! expect: none string:abc bytes:3 string:xy bytes:2 bytes:2
//! emitted-lacks: gea::Value working
