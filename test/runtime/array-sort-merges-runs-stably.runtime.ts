//! expect: random=1
//! expect: stable=1
//! expect: runs=1
//! expect: reversed=1
//! expect: zeros=-0,0,-0,0
//! expect: permutation=1
//! emitted-has: gea::DirectCallable<
// `Array.prototype.sort` is a natural merge sort in the runtime: it keeps the
// runs its input already has, extends short ones by insertion, and merges
// pairs from both ends at once. Every shape that sort treats differently is
// checked against a plain insertion sort -- unordered input, input made of
// sorted runs (what `@geastack/parallel`'s `sorted` hands it), strictly
// descending runs (reversed in place, which only a STRICT descent permits),
// and ties, whose input order a stable sort keeps: `(a, b) => a - b` calls
// `-0` and `0` equal, so they must come out in the order they went in. A
// comparator that contradicts itself may order the result any way, but the
// result must still hold exactly the input's elements.

interface Keyed {
  key: number
  index: number
}

let seed = 12345
const next = (): number => {
  seed = (seed * 16807) % 2147483647
  return seed
}

const reference = (items: number[]): number[] => {
  const out: number[] = []
  for (const value of items) {
    let at = out.length
    while (at > 0 && out[at - 1]! > value) at--
    out.splice(at, 0, value)
  }
  return out
}

const same = (left: number[], right: number[]): number => {
  if (left.length !== right.length) return 0
  for (let index = 0; index < left.length; index++) if (!Object.is(left[index], right[index])) return 0
  return 1
}

const random: number[] = []
for (let index = 0; index < 3000; index++) random.push(next() % 1000)
console.log(
  `random=${same(
    random.slice().sort((a, b) => a - b),
    reference(random)
  )}`
)

const keyed: Keyed[] = []
for (let index = 0; index < 2000; index++) keyed.push({ key: next() % 17, index })
const byKey = keyed.slice().sort((a, b) => a.key - b.key)
let stable = 1
for (let index = 1; index < byKey.length; index++) {
  const before = byKey[index - 1]!
  const after = byKey[index]!
  if (before.key > after.key || (before.key === after.key && before.index > after.index)) stable = 0
}
console.log(`stable=${stable}`)

const runs: number[] = []
for (let run = 0; run < 40; run++) {
  const start = next() % 500
  const length = 1 + (next() % 60)
  for (let index = 0; index < length; index++) runs.push(start + index * (next() % 3))
}
console.log(
  `runs=${same(
    runs.slice().sort((a, b) => a - b),
    reference(runs)
  )}`
)

const reversed: number[] = []
for (let index = 0; index < 500; index++) reversed.push(1000 - index - (index % 7 === 0 ? 1 : 0))
console.log(
  `reversed=${same(
    reversed.slice().sort((a, b) => a - b),
    reference(reversed)
  )}`
)

const zeros = [-0, 0, -0, 0].sort((a, b) => a - b)
console.log(`zeros=${zeros.map((value) => (Object.is(value, -0) ? '-0' : '0')).join(',')}`)

let turn = 7
const shuffled = random.slice().sort(() => {
  turn = (turn * 16807) % 2147483647
  return (turn % 3) - 1
})
console.log(
  `permutation=${same(
    shuffled.sort((a, b) => a - b),
    reference(random)
  )}`
)
