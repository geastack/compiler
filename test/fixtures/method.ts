class Counter {
  count: number = 0

  increment(step: number): number {
    this.count = this.count + step
    return this.count
  }
}

const counter: Counter = new Counter()
const after: number = counter.increment(2)
