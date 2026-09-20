//! oracle: node
class Range {
  start: number
  end: number
  constructor(start: number, end: number) {
    this.start = start
    this.end = end
  }
  [Symbol.iterator](): Iterator<number> {
    let i = this.start
    const limit = this.end
    return {
      next(): IteratorResult<number> {
        if (i < limit) return { value: i++, done: false }
        return { value: undefined as unknown as number, done: true }
      }
    }
  }
}
export function main(): string {
  const out: number[] = []
  for (const n of new Range(1, 5)) out.push(n)
  return 'out=' + out.join(',')
}
console.log(main())
