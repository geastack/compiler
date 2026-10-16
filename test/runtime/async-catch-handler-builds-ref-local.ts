//! expect: emit error boom 3
//! expect: emit error late 2
//! expect: done 2
//! emitted-has: GEA_EH_TRY_VALUE(
//! emitted-has: GEA_EH_CATCH_VALUE(

// An async function whose catch handler builds a reference-counted array and
// calls out with it -- node-compat's events.ts `captureRejection`, reduced.
//
// Under MSVC EH (every Windows build) LLVM's coroutine splitting rewrote the
// cleanup this handler unwinds into so that a value defined in the handler no
// longer dominated its use: `opt -passes=verify` rejected clang's own -O1, -O2
// and -Os output, and clang 22 segfaulted in jump-threading on the resume
// function. The try statement is now written with the `GEA_EH_*` macros, which
// under the MSVC ABI fence it and run the handler after the statement
// (`GEA_EH_FENCED` in the runtime header) and elsewhere are the plain
// statement. This program prints the same lines either way; the Windows
// release gate's -O2 build with the verifier on is what fails without them.

class Emitter {
  emitted = 0
  emit(error: unknown, kind: string, args: unknown[]): void {
    const copy = [...args]
    this.emitted += 1
    console.log(`emit ${kind} ${String(error)} ${copy.length}`)
  }
  async captureRejection(value: Promise<number>, kind: string, args: unknown[]): Promise<void> {
    try {
      await value
    } catch (error) {
      this.emit(error, kind, [...args])
    }
  }
}

const emitter = new Emitter()
const three: unknown[] = []
three.push(1, 2, 3)
const one: unknown[] = []
one.push(4)
const two: unknown[] = []
two.push('a', 'b')
const later = async (): Promise<number> => {
  await Promise.resolve(0)
  throw 'late'
}
await emitter.captureRejection(Promise.reject<number>('boom'), 'error', three)
await emitter.captureRejection(Promise.resolve(1), 'error', one)
await emitter.captureRejection(later(), 'error', two)
console.log(`done ${emitter.emitted}`)
