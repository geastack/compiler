//! dynamic-fallback
//! oracle: node
export function main(): string {
  const target: Record<string, number> = { x: 1, y: 2 }
  const p = new Proxy(target, {})
  p.z = 3
  return 'x=' + p.x + ' y=' + p.y + ' z=' + p.z + ' tx=' + target.x + ' tz=' + target.z
}
console.log(main())
