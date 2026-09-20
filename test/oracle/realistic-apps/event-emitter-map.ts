//! oracle: node
type Listener = (payload: number) => void
class Emitter {
  listeners: Map<string, Listener[]> = new Map<string, Listener[]>()
  on(event: string, fn: Listener): void {
    const arr = this.listeners.get(event) ?? []
    arr.push(fn)
    this.listeners.set(event, arr)
  }
  emit(event: string, payload: number): number {
    const arr = this.listeners.get(event) ?? []
    for (const fn of arr) fn(payload)
    return arr.length
  }
}
export function main(): string {
  const e = new Emitter()
  const seen: number[] = []
  e.on('tick', (n) => seen.push(n * 2))
  e.on('tick', (n) => seen.push(n + 100))
  return 'count=' + e.emit('tick', 5) + ' seen=' + seen.join(',')
}
console.log(main())
