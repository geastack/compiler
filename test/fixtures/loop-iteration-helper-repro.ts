class AsyncRange {
  private index = 0
  private closed = false
  constructor(private readonly limit: number) {}

  async next(): Promise<number | null> {
    if (this.index >= this.limit) return null
    return this.index++
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<number, void, void> {
    if (this.closed) {
      return
    }
    try {
      while (true) {
        const document = await this.next()
        if (document === null) {
          return
        }
        yield document
      }
    } finally {
      this.closed = true
    }
  }
}

const sumAsync = async (limit: number): Promise<number> => {
  let total = 0
  for await (const value of new AsyncRange(limit)) {
    total += value
  }
  return total
}

// Printed, not merely evaluated: this fixture exists because the whole body
// used to vanish -- certified clean, zero lines of C++ -- so "it compiled" is
// not evidence. `AsyncRange(4)` yields 0,1,2,3 and the sum is 6; anything else
// means the `finally`-wrapped `while (true)` producer ran the wrong number of
// iterations.
sumAsync(4).then((total: number) => {
  console.log(`SUM:${total}`)
})
