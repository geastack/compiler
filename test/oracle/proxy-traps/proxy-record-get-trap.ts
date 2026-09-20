//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { x: 5 }
  const log: string[] = []
  const p = new Proxy(target, {
    get(t: Record<string, number>, key: string): unknown {
      log.push('get:' + key)
      if (key === 'x') return (t.x as number) * 100
      return Reflect.get(t, key)
    }
  })
  const a = p.x
  const b = p.x + 1
  return 'a=' + a + ' b=' + b + ' log=' + log.join(',')
}
console.log(main())
