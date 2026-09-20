//! oracle: node
class Range {
  constructor(
    public start: number,
    public end: number
  ) {}
  *[Symbol.iterator](): Generator<number> {
    for (let i = this.start; i < this.end; i++) yield i
  }
}
export function main(): string {
  const out: number[] = []
  for (const n of new Range(10, 14)) out.push(n)
  return 'out=' + out.join(',')
}
console.log(main())
