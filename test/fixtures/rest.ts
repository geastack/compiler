function total(base: number, ...extra: number[]): number {
  return base + extra.length
}

const value: number = total(1, 2, 3)
