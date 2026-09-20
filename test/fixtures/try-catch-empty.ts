// A `catch` clause with an EMPTY body -- ES2019's optional binding plus no
// statements, which is what a program writes when a failure is genuinely to be
// ignored. The handler owns exactly one operation, its own `exception-region`
// boundary, so this is the shape that proves the catch part is entered from
// that boundary rather than from whatever the handler happens to contain.
export function attempt(x: number): number {
  let n = 0
  try {
    if (x > 0) throw new Error('bad')
    n = 1
  } catch {}
  return n
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = attempt(1)
