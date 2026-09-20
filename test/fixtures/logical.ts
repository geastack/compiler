function combine(left: boolean, right: boolean): boolean {
  const both: boolean = left && right
  const either: boolean = left || right
  return both && either
}

function guardValue(flag: boolean, value: number): number {
  if (flag && value > 0) {
    return value
  }
  return 0
}

// Called at module scope so the bodies are emitted rather than shaken away.
export const probe = guardValue(combine(true, false), 3)
