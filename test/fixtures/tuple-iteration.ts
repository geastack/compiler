// `for`-`of` over a fixed-arity tuple.
//
// A tuple is carried as a positional record (`representation/derive.ts`'s
// `deriveTuple`: "a tuple is a record whose keys are its indices"), which is
// the SAME carrier `for`-`in` walks for its keys. For a tuple of strings both
// walks publish a `gea::Iterator<std::string>` cursor, so the carrier cannot
// say which one a `get-iterator` step means -- the IR operation's own
// `protocol` does, and `emit-iterator.ts` dispatches on it before either
// static struct walk. Getting that wrong compiles cleanly and yields
// `"0", "1", "2"` where the program asked for its elements, which is why this
// fixture checks the VALUES rather than only that it compiles.
//
// The positions are unrolled into a reader closure rather than snapshotted:
// the count is a compile-time fact, and re-reading per step is what ECMA-262
// 23.1.5.1 does.

const OPTIONS = ['alpha', 'beta', 'gamma'] as const

const totalLength = (): number => {
  let n = 0
  for (const name of OPTIONS) n += name.length
  return n
}

// The elements themselves, not their positions: `'0' + '1' + '2'` is what a
// keys walk would have produced, and it is not `'alphabetagamma'`.
const joined = (): string => {
  let text = ''
  for (const name of OPTIONS) text = text + name
  return text
}

// A tuple whose positions are numbers, so the cursor's element type is not the
// `std::string` both walks over `OPTIONS` happen to share.
const SCORES = [3, 5, 8] as const

const totalScore = (): number => {
  let n = 0
  for (const score of SCORES) n += score
  return n
}

export const probe = totalLength() + joined().length + totalScore()

// Self-verifying: an uncaught throw at module scope aborts the process, so
// `scripts/run-emitted.mjs`'s exit status is the answer. A certificate and a
// clang-clean emit both say nothing about which walk actually ran.
//
// 14 (5 + 4 + 5) + 14 ('alphabetagamma') + 16 (3 + 5 + 8) = 44.
if (probe !== 44) throw new Error('tuple iteration walked the wrong thing')
