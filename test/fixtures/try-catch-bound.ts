// A bound `catch (error) { ... }` whose caught value is read back through
// `String(error)` -- exactly what `fixtures/spread.ts` and
// `examples/shared/Dialer/store.tsx` do. `error`'s checker type is `unknown`,
// one of the four legitimate dynamic boundaries, so it carries as `dynamic`
// all the way to the native `catch (const gea::Value& vN)` parameter -- see
// `ir/lower-exceptions.ts`'s `lowerBoundary` and `CatchBindingOperation` in
// `ir/model.ts`.
//
// This program compiles. It did not always, and the reason this comment is
// long is that the previous version of it said the program was EXPECTED not
// to -- blaming a `conversion-role:invocation:call:argument` gap in
// `preflight/obligations-graph.ts` that has since been closed. That excuse
// outlived its cause, and while it stood, this fixture was emitting C++ with
// two real defects in it and nobody looked:
//
//   catch (const gea::Value& v7) { v8 = b2; ... }   // reads b2 before any write
//   block3:
//   b2 = v7;                                        // the write, OUTSIDE the catch
//   return;                                         // bare return, std::string function
//
// Both came from one root in `ir/lower-graph.ts`'s `orderOwnerOperations`: a
// `binding:read` cites the *reference*, never the write, so nothing ordered
// the caught binding's initialization before the handler's own statements,
// and the census's post-order ordinal places a `CatchClause`'s own operations
// after the body they contain. The write was scheduled past the handler's
// `return` and landed in the region's join block. See that function's
// `regionParts` loop, which now orders the whole part prologue -- the
// boundary AND the binding chained off it -- ahead of every other member.
//
// A fixture that documents why it cannot compile is a fixture nobody rechecks.
// If this one stops compiling, that is a regression, not a known gap.

function compute(a: number, b: number): number {
  return a / b
}

export function describeFailure(a: number, b: number): string {
  try {
    return String(compute(a, b))
  } catch (error) {
    return String(error)
  }
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = describeFailure(1, 0)
