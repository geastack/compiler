//! dynamic-fallback
//! oracle: node
export function main(): string {
  const fn = (a: number, b: number): number => a + b
  const log: string[] = []
  const p = new Proxy(fn, {
    apply(target: typeof fn, thisArg: unknown, args: unknown[]): number {
      log.push('apply:' + args.map(String).join(','))
      return target(args[0] as number, args[1] as number) * 10
    }
  })
  const r = p(3, 4)
  return 'result=' + r + ' log=' + log.join(',')
}
console.log(main())
