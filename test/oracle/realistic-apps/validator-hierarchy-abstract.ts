//! oracle: node
abstract class Rule {
  abstract check(value: number): boolean
  abstract describe(): string
}
class Min extends Rule {
  constructor(private bound: number) {
    super()
  }
  check(value: number): boolean {
    return value >= this.bound
  }
  describe(): string {
    return 'min(' + this.bound + ')'
  }
}
class Max extends Rule {
  constructor(private bound: number) {
    super()
  }
  check(value: number): boolean {
    return value <= this.bound
  }
  describe(): string {
    return 'max(' + this.bound + ')'
  }
}
export function main(): string {
  const rules: Rule[] = [new Min(0), new Max(100)]
  const tests = [-1, 50, 101]
  const out: string[] = []
  for (const v of tests) {
    let ok = true
    for (const r of rules) if (!r.check(v)) ok = false
    out.push(v + '=' + (ok ? 'ok' : 'no'))
  }
  return rules.map((r) => r.describe()).join(',') + ' :: ' + out.join(' ')
}
console.log(main())
