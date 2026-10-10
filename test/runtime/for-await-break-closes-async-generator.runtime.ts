// `for await` closes its iterator on an abrupt exit (ECMA-262 14.7.5.7
// AsyncIteratorClose), exactly as `for`-`of` does: a `break` or `return` out
// of the loop calls the generator's `return()`, which runs its `finally`.
// A database client's `readMany` returns out of `for await (... of this.dataEvents)`
// and relies on that call to remove `onData`'s socket listeners.
async function* numbers(): AsyncGenerator<number> {
  try {
    yield 1
    yield 2
    yield 3
  } finally {
    console.log('cleanup')
  }
}

const firstOver = async (limit: number): Promise<number> => {
  for await (const value of numbers()) {
    if (value > limit) return value
  }
  return -1
}

const main = async (): Promise<void> => {
  for await (const value of numbers()) {
    console.log(`value:${value}`)
    break
  }
  console.log(`first:${await firstOver(1)}`)
  let total = 0
  for await (const value of numbers()) total += value
  console.log(`total:${total}`)
}
main()
//! expect: value:1
//! expect: cleanup
//! expect: cleanup
//! expect: first:2
//! expect: cleanup
//! expect: total:6
