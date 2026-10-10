// A RETURN OUT OF AN ASYNC GENERATOR'S TRY STATEMENT WHOSE FINALLY AWAITS.
//
// A database client's `AbstractCursor[Symbol.asyncIterator]` is the shape: the body
// returns from inside `try`, and the `finally` awaits cleanup. The return
// value is evaluated (and awaited) first, parked while the clause runs, and
// completes the generator once it has. `for await` never sees the completion
// value, so the loops below read it through `next()` directly; an early
// `break` closes the generator through `return()`, which runs the same clause.
const log: string[] = []

async function cleanup(label: string): Promise<void> {
  await null
  log.push(`cleanup-${label}`)
}

async function* numbers(label: string): AsyncGenerator<number, string> {
  try {
    yield 1
    yield 2
    return `r-${label}`
  } finally {
    await cleanup(label)
    log.push(`finally-${label}`)
  }
}

async function* voidReturn(): AsyncGenerator<number, void> {
  try {
    yield 7
    return
  } finally {
    await cleanup('void')
  }
}

async function main(): Promise<void> {
  for await (const value of numbers('loop')) log.push(`loop-${value}`)
  console.log(log.join(' '))
  log.length = 0

  for await (const value of numbers('break')) {
    log.push(`break-${value}`)
    break
  }
  console.log(log.join(' '))
  log.length = 0

  const cursor = numbers('next')
  const steps: string[] = []
  for (let step = await cursor.next(); ; step = await cursor.next()) {
    steps.push(`${step.value}:${step.done}`)
    if (step.done) break
  }
  console.log(steps.join(' '))
  console.log(log.join(' '))
  log.length = 0

  const empty = voidReturn()
  const first = await empty.next()
  const last = await empty.next()
  console.log(`void:${first.value}:${last.value}:${last.done}`)
  console.log(log.join(' '))
}

main()
//! expect: loop-1 loop-2 cleanup-loop finally-loop
//! expect: break-1 cleanup-break finally-break
//! expect: 1:false 2:false r-next:true
//! expect: cleanup-next finally-next
//! expect: void:7:undefined:true
//! expect: cleanup-void
