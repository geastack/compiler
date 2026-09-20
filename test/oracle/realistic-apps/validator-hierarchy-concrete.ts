//! oracle: node
class MinRule {
  constructor(private bound: number) {}
  check(value: number): boolean {
    return value >= this.bound
  }
  describe(): string {
    return 'min(' + this.bound + ')'
  }
}
class MaxRule {
  constructor(private bound: number) {}
  check(value: number): boolean {
    return value <= this.bound
  }
  describe(): string {
    return 'max(' + this.bound + ')'
  }
}
export function main(): string {
  const minR = new MinRule(0)
  const maxR = new MaxRule(100)
  const tests = [-1, 0, 50, 100, 101]
  const results: string[] = []
  for (const v of tests) {
    const minOk = minR.check(v)
    const maxOk = maxR.check(v)
    results.push(v + '=' + (minOk && maxOk ? 'ok' : 'no'))
  }
  return minR.describe() + ' & ' + maxR.describe() + ' :: ' + results.join(' ')
}
console.log(main())
