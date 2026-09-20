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
  const arr = [...new Range(1, 4)]
  return 'arr=' + arr.join(',')
}
console.log(main())
