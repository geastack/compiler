// lib.es5 and lib.es2020.intl each declare a `new` for `Intl.Collator`, one
// taking `string | string[]` and one `LocalesArgument`, so its constructor type
// has no single construct frame. A program interface can say the same. A slot
// of such a type that nothing constructs through still holds a value, and the
// program compiles: only a construction needs the frame.
interface Maker {
  new (x?: string): { n: number }
  new (x?: number[]): { n: number }
}
let collatorConstructor: typeof Intl.Collator | undefined
const hold = (maker: Maker): Maker => maker
console.log(collatorConstructor === undefined, typeof hold)
//! expect: true function
