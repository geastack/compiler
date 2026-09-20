export function greet(name: string, count: number): string {
  return `Hello, ${name}! You have ${count} new message${count === 1 ? '' : 's'}.`
}

export function percent(value: number): string {
  return `${value}%`
}

export function joined(a: string, b: string): string {
  return `${a}${b}`
}

export function bare(): string {
  return `constant text`
}

export function flagged(on: boolean): string {
  return `state: ${on}`
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = greet('a', 1) + percent(0.5) + joined('a', 'b') + bare() + flagged(true)
