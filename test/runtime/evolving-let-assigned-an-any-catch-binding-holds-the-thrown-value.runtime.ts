// A database client's bulk `executeCommands` (compiled with
// `useUnknownInCatchVariables: false`, so the catch binding is `any`):
//
//   let thrownError = null
//   try { result = await executeOperation(...) } catch (error) { thrownError = error }
//   if (thrownError != null) { if (thrownError instanceof WriteConcernError) ... }
//
// The cell starts `null` and then holds whatever was thrown. The thrown value
// is a genuine dynamic boundary, so the cell carries the thrown error rather
// than only the `null` its initializer states.
class WriteConcernFailure extends Error {
  code = 64
}
function run(n: number): number {
  if (n > 1) throw new WriteConcernFailure('wc')
  if (n > 0) throw new Error('plain')
  return 5
}
function attempt(n: number): string {
  let thrownError = null
  let result
  try {
    result = run(n)
  } catch (error: any) {
    thrownError = error
  }
  if (thrownError != null) {
    if (thrownError instanceof WriteConcernFailure) return 'wc:' + thrownError.code
    return 'other'
  }
  return 'ok:' + result
}
//! expect: ok:5 other wc:64
console.log(attempt(0) + ' ' + attempt(1) + ' ' + attempt(2))
