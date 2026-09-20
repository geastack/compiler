export function label(name: string | null): string {
  return name ?? 'anonymous'
}

export function count(n: number | undefined): number {
  return n ?? 0
}

export function firstTruthy(a: string, b: string): string {
  return a || b
}

/**
 * The miscompile this fixture exists to catch: `??` asks about *presence* and
 * `||` about truthiness, and an empty string is present and falsy. A `??`
 * lowered to a `ToBoolean` test answers `'fallback'` here where the language
 * answers `''` -- a wrong answer that compiles, which is worse than a refusal.
 */
export function emptyStringIsKept(value: string | null): string {
  return value ?? 'fallback'
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = label(null) + count(undefined) + firstTruthy('', 'b') + emptyStringIsKept('')
