// An ambient `declare const` that no host claims, read and written by the
// program: its type is a record this compilation lays out, so no object file
// outside the unit can define it, and the program introduces it nowhere. The
// unit would compile and fail only at link (`Undefined symbols: _process`, the
// database-client correctness probe); the compiler refuses it by name instead.
declare const process: { exitCode: number | undefined }

const fail = (message: string): void => {
  console.log(`failed ${message}`)
  process.exitCode = 1
}

fail('once')
//! expect-refusal: undefined-external-global:process
export {}
