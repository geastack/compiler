//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { name: 1 }
  const log: string[] = []
  const p = new Proxy(target, {
    has(t: Record<string, number>, key: string): boolean {
      log.push('has:' + key)
      if (key.startsWith('_')) return false
      return Reflect.has(t, key)
    }
  })
  const a = 'name' in p
  const b = '_secret' in p
  const c = Reflect.has(p, 'name')
  const d = Reflect.has(p, 'missing')
  return 'a=' + a + ' b=' + b + ' c=' + c + ' d=' + d + ' log=' + log.join(',')
}
console.log(main())
