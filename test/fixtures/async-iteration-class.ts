// `for await (const x of source)` over a class whose `[Symbol.asyncIterator]`
// is an `async function*`. mongodb's `AbstractCursor` is exactly this shape,
// and every `for await` over one refused: the async generator's `yield` was
// refused by name, `iteration-yield.ts` looked up only `__@iterator` so the
// element type came back unresolved, `mintIteratorSteps` left the async
// method and record types unresolved on purpose, the target claimed no
// `protocol:async-iterator:*` helper, and `for await` alone was excluded from
// the reshape into a condition-driven loop.
//
// All five rested on one unexamined assumption -- that an async iteration
// suspends. In THIS runtime it does not: `gea::Promise<V>` is a settled-value
// box with no job queue, so every `await` is a synchronous read and an async
// body has run to completion by the time it returns. Under that model an
// async generator IS a synchronous cursor, which is the carrier the compiler
// already had. A port that grows a real job queue must revisit all of it
// together with `await` and `Promise::then`, never one piece alone.
class Counter {
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<number, void, undefined> {
    for (let index = 0; index < this.limit; index += 1) {
      yield index * 2
    }
  }
}

const total = async (source: Counter): Promise<number> => {
  let sum = 0
  for await (const value of source) {
    sum += value
  }
  return sum
}

export const probe = await total(new Counter(5))

if (probe !== 20) throw new Error('async iteration walked the wrong thing')
