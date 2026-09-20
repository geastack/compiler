//! oracle: node
class PQ {
  items: number[] = []
  push(value: number): void {
    let i = 0
    while (i < this.items.length && this.items[i] < value) i++
    this.items.splice(i, 0, value)
  }
  pop(): number {
    const top = this.items[0]
    this.items.splice(0, 1)
    return top
  }
  size(): number {
    return this.items.length
  }
}
export function main(): string {
  const pq = new PQ()
  const inputs = [5, 1, 8, 3, 7, 2, 9, 4, 6]
  for (const n of inputs) pq.push(n)
  const drained: number[] = []
  while (pq.size() > 0) drained.push(pq.pop())
  return 'sorted=' + drained.join(',')
}
console.log(main())
