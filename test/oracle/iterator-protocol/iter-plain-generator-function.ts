//! oracle: node
function* range(start: number, end: number): Generator<number> {
  for (let i = start; i < end; i++) yield i
}
export function main(): string {
  const out: number[] = []
  for (const n of range(0, 5)) out.push(n)
  return 'out=' + out.join(',')
}
console.log(main())
