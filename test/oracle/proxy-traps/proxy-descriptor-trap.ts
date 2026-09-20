//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { x: 7 }
  const p = new Proxy(target, {
    getOwnPropertyDescriptor(t: Record<string, number>, key: string): PropertyDescriptor | undefined {
      if (key === 'x') return { configurable: true, enumerable: true, value: (t.x as number) * 2, writable: true }
      return undefined
    }
  })
  const d = Reflect.getOwnPropertyDescriptor(p, 'x')
  return 'value=' + (d ? String(d.value) : 'none')
}
console.log(main())
