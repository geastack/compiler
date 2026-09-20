// A generator METHOD reads `this` after the first `next()`, which is after its
// caller's frame is gone.
//
// C++20 copies a coroutine's parameters into the frame -- but a REFERENCE
// parameter is copied as a reference. The emitter took a refcounted receiver
// by `const&` on the measured grounds that the caller owns it for the whole
// call (`cppRefcountedReceiver`, 31.9ms -> 15.9ms on `method_calls.ts`), and
// that reasoning is exactly false for a coroutine: it suspends at
// `initial_suspend` and returns immediately, so the thunk's own by-value
// `gea_this` is destroyed before the body ever runs.
//
// The result certified, cleared clang with no warning, and read freed memory:
// this fixture walked ZERO elements because `this.limit` came back as garbage.
// Whether it runs at all is undefined behaviour, which is why no gate above
// the running program could have caught it -- the only instrument that could
// was executing the thing and checking the answer.
class Counter {
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  *[Symbol.iterator](): Generator<number, void, undefined> {
    for (let index = 0; index < this.limit; index += 1) {
      yield index * 2
    }
  }
}

const total = (source: Counter): number => {
  let sum = 0
  for (const value of source) {
    sum += value
  }
  return sum
}

export const probe = total(new Counter(5))

if (probe !== 20) throw new Error('a generator method read a dangling receiver')
