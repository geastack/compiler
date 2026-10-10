// `for await` over a value typed by the AsyncIterable interface: its
// iterator's `next()` answers a promise of `{ value, done }` (ECMA-262
// 27.1.1.3), awaited before each step. A database client walks a
// listCollections cursor this way in its client-side encryption state machine.

const countdown = (from: number): AsyncIterable<number> => ({
  [Symbol.asyncIterator](): AsyncIterator<number> {
    let current = from
    return {
      next: async (): Promise<IteratorResult<number>> => {
        if (current <= 0) return { value: undefined, done: true }
        current -= 1
        return { value: current + 1, done: false }
      }
    }
  }
})

async function main(): Promise<void> {
  const seen: number[] = []
  for await (const value of countdown(3)) seen.push(value)
  //! expect: seen=3,2,1
  console.log('seen=' + seen.join(','))
  let total = 0
  for await (const value of countdown(10)) {
    total += value
    if (total > 20) break
  }
  //! expect: total=27
  console.log('total=' + total)
}
void main()
