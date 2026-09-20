interface Counter {
  value: number
}

export function bump(counter: Counter): number {
  let total = 0
  total += counter.value
  counter.value = total
  counter.value += 2
  return total
}

// Called at module scope so the body is emitted rather than shaken away.
export const probe = bump({ value: 1 })
