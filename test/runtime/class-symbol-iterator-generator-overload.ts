//! expect: a
//! expect: b
//! expect: a
//! expect: b
// A symbol-keyed generator method behind an overload signature is the shape
// node-compat's URLSearchParams uses (`runtime/node/globals.ts`). The named
// `entries()` twin certified while `[Symbol.iterator]` reported "no
// function-object allocation published a callable carrier" at the SIGNATURE:
// the census descended into the bodiless overload and minted its computed
// key's `Symbol.iterator` read under a function id nothing allocates.
class Params {
  private names: string[] = ['a', 'b']
  entries(): IterableIterator<string>
  *entries(): Generator<string> {
    for (let i = 0; i < this.names.length; i++) yield this.names[i]!
  }
  [Symbol.iterator](): IterableIterator<string>
  *[Symbol.iterator](): Generator<string> {
    for (let i = 0; i < this.names.length; i++) yield this.names[i]!
  }
}
const params = new Params()
for (const key of params.entries()) console.log(key)
for (const key of params) console.log(key)
