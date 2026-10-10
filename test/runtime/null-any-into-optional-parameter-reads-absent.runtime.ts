// A database client's bulk `executeCommands` keeps `let thrownError = null` (typed `any`)
// and, on success, passes it to `mergeBatchResults(batch, result, err?:
// AnyError, ...)`, which only tests `if (err)`. The null reaches a parameter
// declared `T | undefined` with no default; it reads as the absence.
class DriverError extends Error {}

function merge(label: string, err?: Error | DriverError, result?: { n: number }): string {
  if (err) return `${label} error ${err.message}`
  return `${label} ok ${result?.n ?? 0}`
}

async function run(fail: boolean): Promise<string> {
  let thrownError = null
  let result
  try {
    if (fail) throw new DriverError('boom')
    result = { n: 3 }
  } catch (error: any) {
    thrownError = error
  }
  return merge(fail ? 'fail' : 'pass', thrownError, result)
}

console.log(await run(false))
console.log(await run(true))

//! expect: pass ok 3
//! expect: fail error boom
//! emitted-has: gea_nullish
