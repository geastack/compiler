// ECMA-262 27.2.4.1: `Promise.all` takes any iterable. A database client's
// encryption state machine awaits `Promise.all(this.requests(context))`, a
// generator yielding one promise per KMS request; a generator that throws
// while being iterated makes the call answer a rejected promise instead of throwing synchronously.

const log: string[] = []

function* requests(count: number): Generator<Promise<void>> {
  for (let index = 0; index < count; index += 1) {
    log.push('start ' + index)
    yield Promise.resolve().then(() => {
      log.push('done ' + index)
    })
  }
}

function* failing(): Generator<Promise<void>> {
  yield Promise.resolve()
  throw new Error('iteration failed')
}

async function main(): Promise<void> {
  await Promise.all(requests(3))
  //! expect: start 0,start 1,start 2,done 0,done 1,done 2
  console.log(log.join(','))
  const pending = Promise.all(failing())
  //! expect: returned a promise
  console.log('returned a promise')
  try {
    await pending
  } catch (error) {
    //! expect: rejected: iteration failed
    console.log('rejected: ' + (error as Error).message)
  }
}

main()
