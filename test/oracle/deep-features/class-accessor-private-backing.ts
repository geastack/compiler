//! oracle: node
class Temperature {
  #celsius: number = 0
  get fahrenheit(): number {
    return (this.#celsius * 9) / 5 + 32
  }
  set fahrenheit(f: number) {
    this.#celsius = ((f - 32) * 5) / 9
  }
  get celsius(): number {
    return this.#celsius
  }
  set celsius(c: number) {
    this.#celsius = c
  }
}
export function main(): string {
  const t = new Temperature()
  t.celsius = 100
  const f1 = t.fahrenheit
  t.fahrenheit = 32
  const c2 = t.celsius
  return 'f1=' + f1 + ' c2=' + c2
}
console.log(main())
