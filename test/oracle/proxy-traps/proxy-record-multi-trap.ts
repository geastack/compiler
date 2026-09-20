//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { count: 0 }
  const log: string[] = []
  const p = new Proxy(target, {
    get(t: Record<string, number>, key: string): unknown {
      log.push('g:' + key)
      return Reflect.get(t, key)
    },
    set(t: Record<string, number>, key: string, value: unknown): boolean {
      log.push('s:' + key + '=' + String(value))
      t[key] = value as number
      return true
    },
    has(t: Record<string, number>, key: string): boolean {
      log.push('h:' + key)
      return Reflect.has(t, key)
    },
    deleteProperty(t: Record<string, number>, key: string): boolean {
      log.push('d:' + key)
      return Reflect.deleteProperty(t, key)
    }
  })
  Reflect.set(p, 'count', 1)
  Reflect.set(p, 'count', (Reflect.get(p, 'count') as number) + 1)
  const has1 = Reflect.has(p, 'count')
  const ok = Reflect.deleteProperty(p, 'count')
  const has2 = Reflect.has(p, 'count')
  return 'final=' + (target.count ?? 'gone') + ' ok=' + ok + ' has1=' + has1 + ' has2=' + has2 + ' log=' + log.join('|')
}
console.log(main())
