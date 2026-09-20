//! oracle: node
function fib(n: number, cache: Map<number, number>): number {
  if (n < 2) return n
  const cached = cache.get(n)
  if (cached !== undefined) return cached
  const result = fib(n - 1, cache) + fib(n - 2, cache)
  cache.set(n, result)
  return result
}
export function main(): string {
  const cache = new Map<number, number>()
  const out: number[] = []
  for (let i = 0; i <= 12; i++) out.push(fib(i, cache))
  return 'fib=' + out.join(',') + ' size=' + cache.size
}
console.log(main())
