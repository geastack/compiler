//! oracle: node
class LRU {
  capacity: number
  store: Map<string, number> = new Map<string, number>()
  constructor(capacity: number) {
    this.capacity = capacity
  }
  get(key: string): number {
    if (!this.store.has(key)) return -1
    const value = this.store.get(key) as number
    this.store.delete(key)
    this.store.set(key, value)
    return value
  }
  put(key: string, value: number): void {
    if (this.store.has(key)) this.store.delete(key)
    else if (this.store.size >= this.capacity) {
      const firstKey = this.store.keys().next().value as string
      this.store.delete(firstKey)
    }
    this.store.set(key, value)
  }
}
export function main(): string {
  const cache = new LRU(3)
  cache.put('a', 1)
  cache.put('b', 2)
  cache.put('c', 3)
  const got1 = cache.get('a')
  cache.put('d', 4)
  return 'a=' + got1 + ' b=' + cache.get('b') + ' a-after=' + cache.get('a')
}
console.log(main())
