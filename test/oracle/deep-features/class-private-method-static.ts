//! oracle: node
class Counter {
  static #total: number = 0
  #step: number = 1
  value: number = 0
  constructor(step: number) {
    this.#step = step
  }
  #increment(): void {
    this.value += this.#step
    Counter.#total += this.#step
  }
  tick(times: number): number {
    for (let i = 0; i < times; i++) this.#increment()
    return this.value
  }
  static getTotal(): number {
    return Counter.#total
  }
}
export function main(): string {
  const a = new Counter(2)
  const b = new Counter(5)
  a.tick(3)
  b.tick(2)
  return 'a=' + a.value + ' b=' + b.value + ' total=' + Counter.getTotal()
}
console.log(main())
