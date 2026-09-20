//! expect: boom
//! expect: premature
//! expect: unknown error
//! expect: not an error
// `@hono/node-server` listener.ts `handleResponseError`: the caught value is
// re-typed `Error & { code: string }` so the handler can tell a premature
// stream close from an application error. `Error` is an INTERFACE bound to the
// native `gea::runtime::Error`, and the intersection has to keep that native
// handle -- flattening it into a structural record of the merged members is a
// copy the `new Error(...)` on the other side of the ternary cannot become.
//
// The `{ cause }` on that construction is the second half: ECMA-262 20.5.8.1
// installs `cause` as an own property of the new error, and the runtime's
// `Error` tracks its presence, so the construction has to reach `setCause`
// rather than drop the options bag.
//
// Every error this hands to `describe` carries a `code`, because `code` is
// declared REQUIRED by the assertion: reading a required own property that was
// never written is a program bug the runtime traps, exactly as it does for the
// shipped `RegExp & { route: string }` precedent.
const unknownError = (thrown: unknown): Error & { code: string } => {
  const err = new Error('unknown error', { cause: thrown }) as Error & { code: string }
  err.code = 'ERR_UNKNOWN'
  return err
}

const describe = (thrown: unknown): string => {
  const err = thrown instanceof Error ? (thrown as Error & { code: string }) : unknownError(thrown)
  return err.code === 'ERR_STREAM_PREMATURE_CLOSE' ? 'premature' : err.message
}

const boom = new Error('boom') as Error & { code: string }
boom.code = 'ERR_APP'

const premature = new Error('closed') as Error & { code: string }
premature.code = 'ERR_STREAM_PREMATURE_CLOSE'

console.log(describe(boom))
console.log(describe(premature))
console.log(describe('not an error'))
console.log(String(unknownError('not an error').cause))
