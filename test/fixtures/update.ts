class Counter {
  count: number = 0

  bump(): number {
    this.count++
    return ++this.count
  }
}

let total: number = 0

function step(): number {
  const before: number = total++
  --total
  return before
}
