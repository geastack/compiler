//! expect: undefined 3
// A plain call of a callable whose type states `this` supplies undefined.
type Handler = (this: unknown, ...args: unknown[]) => unknown
const handler: Handler = function (this: unknown, ...args: unknown[]) {
  console.log(typeof this, args.length)
}
handler(1, 2, 3)
