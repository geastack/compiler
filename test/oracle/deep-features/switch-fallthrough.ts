//! oracle: node
function classify(n: number): string {
  const out: string[] = []
  switch (n) {
    case 1:
    case 2:
      out.push('low')
      break
    case 3:
      out.push('mid')
    case 4:
      out.push('mid-or-fall')
      break
    case 5:
      out.push('five')
      return 'early=five'
    default:
      out.push('default')
  }
  out.push('after')
  return out.join('|')
}
export function main(): string {
  const tests = [1, 2, 3, 4, 5, 6]
  return tests.map((n) => n + ':' + classify(n)).join(' ')
}
console.log(main())
