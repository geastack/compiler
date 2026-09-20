// A rest parameter stored where the SLOT declares its own rest at position 0.
//
// ECMAScript has one calling convention: a call binds arguments to positions
// and packs whatever is left into the rest. So `(base?: string, sub?: string,
// ...rest: string[]) => string` and `(...paths: string[]) => string` are the
// same function, and TypeScript accepts the first as the second -- hono's
// `utils/url.ts` declares exactly that pair on one `const`. C++ sees two
// unrelated function types, one taking a single array and one taking two
// optionals and an array, so the store needs a thunk.
//
// What running it proves that reading the emitted C++ does not: the leading
// positions are read out of the array IN ORDER (not reversed, not off by one);
// a position the call never reached is ABSENT rather than a fabricated empty
// string; and the elements past the leading run really do arrive as the
// source's own rest, in order and complete.

const joinPaths: (...paths: string[]) => string = (base?: string, sub?: string, ...rest: string[]): string => {
  const head = base === undefined ? '<none>' : base
  const next = sub === undefined ? '<none>' : sub
  return head + '|' + next + '|' + rest.length + '[' + rest.join(',') + ']'
}

//! expect: two=a|b|0[]
console.log('two=' + joinPaths('a', 'b'))

//! expect: one=a|<none>|0[]
console.log('one=' + joinPaths('a'))

//! expect: none=<none>|<none>|0[]
console.log('none=' + joinPaths())

//! expect: five=a|b|3[c,d,e]
console.log('five=' + joinPaths('a', 'b', 'c', 'd', 'e'))

// The same callable read back out of the cell and passed on as a value: the
// thunk has to survive being copied, since what the cell holds is the adapted
// callable and not the function it was written from.
const apply = (f: (...paths: string[]) => string, parts: string[]): string => f(...parts)

//! expect: forwarded=x|y|1[z]
console.log('forwarded=' + apply(joinPaths, ['x', 'y', 'z']))
