//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { x: 0 }
  const log: string[] = []
  const p = new Proxy(target, {
    set(t: Record<string, number>, key: string, value: unknown): boolean {
      log.push('set:' + key + '=' + String(value))
      if ((value as number) < 0) return false
      t[key] = value as number
      return true
    }
  })
  const ok1 = Reflect.set(p, 'x', 7)
  const ok2 = Reflect.set(p, 'x', -1)
  return 'x=' + p.x + ' ok1=' + ok1 + ' ok2=' + ok2 + ' log=' + log.join(',')
}
console.log(main())
