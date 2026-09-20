//! dynamic-fallback
//! oracle: node
interface T {
  count: number
  tag: string
}
export function main(): string {
  const target: T = { count: 0, tag: 'init' }
  const p = new Proxy(target, {})
  p.count = 7
  p.tag = 'done'
  return 'p=' + p.count + ',' + p.tag + ' t=' + target.count + ',' + target.tag
}
console.log(main())
