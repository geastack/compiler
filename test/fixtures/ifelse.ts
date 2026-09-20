function classify(value: number): number {
  let out: number = 0
  if (value > 10) {
    out = 1
  } else {
    out = 2
  }
  return out
}

// Called at module scope so the body is emitted rather than shaken away.
export const probe = classify(11)
