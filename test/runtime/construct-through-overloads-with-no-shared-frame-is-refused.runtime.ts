// A constructor type whose construct overloads join into no frame is held by
// its identity alone. Constructing through it is refused at certification, by
// name, not in the printer.
interface Maker {
  new (x?: string): { n: number }
  new (x?: number[]): { n: number }
}
const build = (maker: Maker): number => new maker('a').n
console.log(typeof build)
//! expect-refusal: call-abi:no-construct-path:callable-identity
