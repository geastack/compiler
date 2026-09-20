// node-server `websocket.ts:281/318/349/357` -- `(options?.onError ??
// console.error)(e)`. The two arms are callables whose call shapes differ only
// in how the ONE argument arrives: the kept arm declares it positionally, the
// fallback takes it through a rest array. TypeScript reduces the merged type to
// the rest signature (the positional handler is assignable to it), so the merge
// publishes that frame while the kept operand still carries the optional the
// FIELD holds.
//
// Both halves of the arm's route are already installed -- the presence load out
// of the optional, and the callable adapter a plain `flag ? positional : rest`
// already lowers through -- and only their composition was missing. `??`'s own
// nullish test is what licenses it, so the unwrap stays branch-local rather
// than becoming a global `optional(T) -> U`.
type ErrorHandler = (e: unknown) => void

const report = (...data: unknown[]): void => {
  console.log('rest', data.length)
}

const run = (options: { onError?: ErrorHandler } | undefined, e: unknown): void => {
  ;(options?.onError ?? report)(e)
}

// The `||` spelling of the same composition: an absent optional is falsy, so
// the truthiness test proves presence exactly as the nullish test does.
const runOrElse = (handler: ErrorHandler | undefined, e: unknown): void => {
  ;(handler || report)(e)
}

run({ onError: (e) => console.log('own', String(e)) }, 'a')
run(undefined, 'b')
run({}, 'c')
runOrElse((e) => console.log('own', String(e)), 'd')
runOrElse(undefined, 'e')
//! expect: own a
//! expect: rest 1
//! expect: rest 1
//! expect: own d
//! expect: rest 1
