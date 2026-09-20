//! oracle: node
function makeIter(): Generator<string> {
  return (function* (): Generator<string> {
    yield 'a'
    yield 'b'
    yield 'c'
  })()
}
export function main(): string {
  const out: string[] = []
  for (const v of makeIter()) out.push(v)
  return 'out=' + out.join('-')
}
console.log(main())
