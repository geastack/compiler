class Counter {
  count: number = 0

  incrementLater(): () => void {
    return () => {
      this.count = this.count + 1
    }
  }
}

const counter: Counter = new Counter()
const later: () => void = counter.incrementLater()
later()
