//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { x: 1, y: 2, z: 3 }
  const log: string[] = []
  const p = new Proxy(target, {
    deleteProperty(t: Record<string, number>, key: string): boolean {
      log.push('delete:' + key)
      if (key === 'z') return false
      return Reflect.deleteProperty(t, key)
    }
  })
  const ok1 = Reflect.deleteProperty(p, 'x')
  const ok2 = Reflect.deleteProperty(p, 'y')
  const ok3 = Reflect.deleteProperty(p, 'z')
  return 'ok1=' + ok1 + ' ok2=' + ok2 + ' ok3=' + ok3 + ' log=' + log.join(',')
}
console.log(main())
