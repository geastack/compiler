// `(...args: never[]) => R` is not a calling convention. `never` is
// uninhabited, so no call through the slot can supply an argument, and the
// type is TypeScript's way of writing "some function, which nobody here
// calls" -- it is `AnyFunction` in tsc's own `core.ts`, and every use of it
// there ends at `Error.captureStackTrace`. The carrier is the identity half
// every callable already owns, so a concrete function converts into it by
// reading a field rather than by being fitted to a frame it does not have.
type AnyFunction = (...args: never[]) => void

function fail(message: string, stackCrawlMark?: AnyFunction): void {
  console.log(message, stackCrawlMark === undefined ? 'none' : 'marked')
}

function assertIsDefined(value: number | undefined, message?: string, stackCrawlMark?: AnyFunction): void {
  // tsc's own idiom, and the largest single obligation family in its
  // self-compile: the merge target is the identity and the right arm is an
  // ordinary concrete function of a completely different arity.
  if (value === undefined) fail(message ?? 'undefined', stackCrawlMark || assertIsDefined)
}

assertIsDefined(undefined, 'absent')
assertIsDefined(7, 'present')

function marker(): void {
  console.log('marker ran')
}

const held: AnyFunction = marker
const again: AnyFunction = marker

// An identity is the ECMAScript function object, so two conversions of one
// function are the same value, and a different function is not.
console.log(held === again)
console.log(held === (assertIsDefined as AnyFunction))

marker()

//! expect: absent marked
//! expect: true
//! expect: false
//! expect: marker ran
