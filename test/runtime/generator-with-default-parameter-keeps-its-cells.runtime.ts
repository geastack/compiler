//! expect: 0 5 1 6 2 7
//! expect: 10 11 12

// A database client's `makeCounter`: a generator whose parameter has a default
// and whose loop locals persist across `yield`. The locals live in cells the
// generator's frame owns; they must outlive the call that created the
// iterator, since every `next()` resumes into them after it has returned.

export function* makeCounter(seed = 0): Generator<number> {
  let count = seed
  while (true) {
    const newCount = count
    count += 1
    yield newCount
  }
}

const first = makeCounter()
const second = makeCounter(5)
const noise: number[][] = []
for (let i = 0; i < 64; i++) noise.push([i, i + 1, i + 2])
const interleaved: number[] = []
for (let i = 0; i < 3; i++) interleaved.push(first.next().value, second.next().value)
console.log(interleaved.join(' '))
const third = makeCounter(10)
console.log(third.next().value + ' ' + third.next().value + ' ' + third.next().value + (noise.length > 0 ? '' : '!'))
