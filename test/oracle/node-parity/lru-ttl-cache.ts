interface Entry {
  value: number
  expiresAt: number
}

class LruTtlCache {
  capacity: number
  ttl: number
  store: Map<string, Entry> = new Map<string, Entry>()

  constructor(capacity: number, ttl: number) {
    this.capacity = capacity
    this.ttl = ttl
  }

  get(key: string, now: number): number {
    const entry = this.store.get(key)
    if (entry === undefined) return -1
    if (entry.expiresAt <= now) {
      this.store.delete(key)
      return -1
    }
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  put(key: string, value: number, now: number): void {
    if (this.store.has(key)) this.store.delete(key)
    this.store.set(key, { value, expiresAt: now + this.ttl })
    this.evict(now)
  }

  snapshot(now: number): string {
    this.evict(now)
    const out: string[] = []
    for (const key of this.store.keys()) {
      const entry = this.store.get(key)
      if (entry !== undefined) out.push(key + ':' + entry.value + '@' + entry.expiresAt)
    }
    return out.join('|')
  }

  private evict(now: number): void {
    const keys: string[] = []
    for (const key of this.store.keys()) keys.push(key)
    for (const key of keys) {
      const entry = this.store.get(key)
      if (entry !== undefined && entry.expiresAt <= now) this.store.delete(key)
    }
    while (this.store.size > this.capacity) {
      const oldest = this.oldestKey()
      if (oldest === '') break
      this.store.delete(oldest)
    }
  }

  private oldestKey(): string {
    for (const key of this.store.keys()) return key
    return ''
  }
}

export function main(): string {
  const cache = new LruTtlCache(3, 5)
  cache.put('a', 10, 0)
  cache.put('b', 20, 0)
  cache.put('c', 30, 1)
  const a2 = cache.get('a', 2)
  cache.put('d', 40, 3)
  const b3 = cache.get('b', 3)
  const a4 = cache.get('a', 4)
  const a5 = cache.get('a', 5)
  cache.put('e', 50, 6)
  return 'a2=' + a2 + ' b3=' + b3 + ' a4=' + a4 + ' a5=' + a5 + ' final=' + cache.snapshot(6)
}

console.log(main())
