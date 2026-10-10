// `IteratorResult<Uint8Array>` is `IteratorYieldResult<Uint8Array> |
// IteratorReturnResult<any>`, and a `{ value, done }` record fits BOTH arms:
// the yield arm as written, the return arm by boxing `value` into its `any`.
// Boolean literals do not survive structural normalization, so `done: false`
// and `done: finished` are one source carrier and the arm can only be read
// off `done` at runtime. Picking the return arm statically ended every loop
// before its first element; picking the yield arm reported a finished
// iterator as still running.
//
// The async half is a database client's `onData` shape stored where `Connection`
// keeps it: `dataEvents: AsyncGenerator<Buffer, void, void> | null`.
function onData(chunks: Uint8Array[]) {
  let finished = false
  const iterator: AsyncGenerator<Uint8Array> & AsyncDisposable = {
    next() {
      const value = chunks.shift()
      if (value != null) return Promise.resolve({ value, done: false })
      finished = true
      return Promise.resolve({ value: undefined, done: finished })
    },
    return() {
      finished = true
      return Promise.resolve({ value: undefined, done: true } as const)
    },
    throw(err: Error) {
      console.log(`throw:${err.message}`)
      return Promise.resolve({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return this
    },
    async [Symbol.asyncDispose]() {}
  }
  return iterator
}

class Holder {
  dataEvents: AsyncGenerator<Uint8Array, void, void> | null = null
  async run(chunks: Uint8Array[]): Promise<number> {
    let total = 0
    this.dataEvents = onData(chunks)
    for await (const chunk of this.dataEvents) total += chunk.length
    this.dataEvents = null
    return total
  }
}

function counter(limit: number): Iterator<Uint8Array> {
  let index = 0
  return {
    next() {
      const done = index >= limit
      const value = new Uint8Array(index++)
      return { value, done }
    }
  }
}

const main = async (): Promise<void> => {
  console.log(`async:${await new Holder().run([new Uint8Array([1, 2]), new Uint8Array([3])])}`)
  const cursor = counter(3)
  let step = cursor.next()
  let lengths = ''
  while (!step.done) {
    lengths += `${step.value.length},`
    step = cursor.next()
  }
  console.log(`sync:${lengths}`)
}
main()
//! expect: async:3
//! expect: sync:0,1,2,
