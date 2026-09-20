// `+` is string concatenation whenever the plan says the result is a string, and
// both sides then go through ToString -- the same fold a template expression
// uses, since `'n: ' + count` and `` `n: ${count}` `` are the same value.
export function labelled(count: number): string {
  return 'count: ' + count
}

export function flagged(on: boolean): string {
  return 'on: ' + on
}

export function joined(a: string, b: string): string {
  return a + b
}

export function leading(count: number): string {
  return count + ' items'
}

// Numeric `+` must stay numeric addition, not concatenation.
export function summed(a: number, b: number): number {
  return a + b
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = labelled(1) + flagged(true) + joined('a', 'b') + leading(2) + String(summed(1, 2))
