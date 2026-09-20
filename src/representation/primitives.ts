import type { Representation } from './model.js'

/**
 * The lattice's bottom, carrying why it was reached.
 *
 * Not an answer: `unresolved` is what a deriver publishes when it has no
 * carrier to name, and every consumer treats it as a gap to report rather than
 * a storage decision to act on (`docs/ARCHITECTURE.md` invariant 3).
 */
export const unresolved = (reason: string): Representation => ({ kind: 'unresolved', reason })

/**
 * The carrier a *stored* position holds, where `void` is a value.
 *
 * `void` is two different facts wearing one spelling. As a function's own
 * result it means "this evaluation completes with no result", which occupies
 * no storage and is C++'s own `void`. Anywhere a value is actually kept --
 * a union arm, a parameter slot, a record field, an array element -- there is
 * no such thing as a value that is not there: ECMAScript's answer is
 * `undefined`, which is what a `void`-returning call evaluates to, what
 * `Promise<void>.then` hands its callback, and what a `void[]` holds.
 *
 * Deriving `{kind: 'void'}` into those positions is what produced carriers no
 * backend could spell -- `tagged-union(0:void|1:...)` for
 * `TResult | PromiseLike<TResult>` at `TResult = void`, `array-object(void)`,
 * `(void) -> void` for `Promise<void>`'s own `then` callback -- and seven
 * corpus apps were refused for it. The refusal was right; the carrier was
 * wrong.
 *
 * `never` maps to the same physical nothing and is converted with it, and that
 * is sound for the same reason it is uninteresting: a slot typed `never` is
 * never reached, so which empty carrier stands in its place is unobservable --
 * `never[]` is the empty array literal, and `(event: never) => void` is a
 * listener no call site can supply an argument for. What matters is that a
 * position which must be able to hold something is given a carrier that can.
 *
 * The one place where `never` is NOT interchangeable is a union arm, and that
 * is handled where it belongs: the union deriver drops `never` members before
 * building any arm, because `T | never` is `T` and an arm for the empty type
 * would be an arm nothing can ever be. Left in, `null | never` came out as a
 * sum of two absences -- one flag, two meanings -- and a field that is plainly
 * just `null` was refused.
 */
export const storedCarrier = (representation: Representation): Representation =>
  representation.kind === 'void' ? { kind: 'undefined' } : representation

/** The carrier a primitive type name occupies, or `null` for a name that is not one. */
export const primitiveCarrier = (primitive: string): Representation | null => {
  switch (primitive) {
    // `never` denotes a value that is never produced, so it carries nothing.
    // That is not the same as `void`, which is a completed evaluation with no
    // result -- but physically both occupy no storage, so both are the one
    // carrier and `bottom` records which of the two facts this position holds.
    // Only the decisions that turn on "can a value ever arrive here" read it
    // (`Promise<never>` adopting into `Promise<T>`); every storage decision
    // reads `kind` and cannot tell them apart, which is the point.
    case 'never':
      return { kind: 'void', bottom: true }
    case 'void':
      return { kind: 'void' }
    case 'undefined':
      return { kind: 'undefined' }
    case 'null':
      return { kind: 'null' }
    case 'boolean':
      return { kind: 'scalar', domain: 'boolean' }
    case 'number':
      return { kind: 'scalar', domain: 'number' }
    case 'bigint':
      return { kind: 'scalar', domain: 'bigint' }
    case 'string':
      return { kind: 'string' }
    case 'symbol':
      return { kind: 'symbol' }
    // The program declared this value dynamic and never narrowed it. This is one
    // of the four reasons the boxed carrier is admissible at all.
    case 'unknown':
    case 'any':
      return { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
    default:
      return null
  }
}
