function sum(limit: number): number {
  let total: number = 0
  for (let i: number = 0; i < limit; i++) {
    if (i % 2 === 0) {
      total = total + i
    } else {
      total = total - i
    }
  }
  let guard: number = 0
  while (guard < limit) {
    guard = guard + 1
  }
  return total
}

function pick(flag: boolean): number {
  return flag ? 1 : 2
}

// Called at module scope so the bodies are emitted rather than shaken away.
export const probe = sum(4) + pick(true)
