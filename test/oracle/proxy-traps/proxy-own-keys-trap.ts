//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { a: 1, b: 2, c: 3 }
  const p = new Proxy(target, {
    ownKeys(): string[] {
      return ['a', 'c']
    }
  })
  return 'keys=' + Object.keys(p).join(',')
}
console.log(main())
