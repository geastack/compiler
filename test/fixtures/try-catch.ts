// `try`/`catch` over ordinary synchronous code, straight-line only, with a
// bindingless handler that simply recovers -- the shape `fixtures/spread.ts`
// needs. No `finally` here: that clause needs an RAII scope-guard primitive
// this compiler does not build yet, and is refused by name rather than
// silently mishandled (`ir/lower.ts`'s `'try'` case).
//
// A bound catch (`catch (error) { ...String(error)... }`, the other shape
// the target programs need) lives in `try-catch-bound.ts` instead of here:
// it hits a separate, pre-existing gap -- `conversionRoleDispositionOf` in
// `preflight/obligations-graph.ts` has no case for the `invocation` family,
// so passing the caught (dynamically-carried) value into `String(...)`
// raises an unclassified `conversion-role:invocation:call:argument`
// obligation this program can never satisfy. That gap predates this fixture
// and is not specific to try/catch -- it would fire for any dynamically
// carried value passed as an argument to a concretely-typed call -- so it is
// out of scope here. Keeping it in a separate file lets this one prove the
// exception-region mechanics (frame stack, join block, native catch-all)
// reach an actual clang-clean compile on their own.
function compute(a: number, b: number): number {
  return a / b
}

export function safeDivide(a: number, b: number): number {
  try {
    return compute(a, b)
  } catch {
    return -1
  }
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = safeDivide(1, 0)
