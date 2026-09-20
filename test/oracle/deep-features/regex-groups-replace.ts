//! oracle: node
export function main(): string {
  const text = 'count=12, total=345, ratio=0.5'
  const replaced = text.replace(/(\d+)/g, (m: string) => '#' + m)
  const numbers: number[] = []
  const re = /\d+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) numbers.push(Number(match[0]))
  return 'replaced=' + replaced + ' nums=' + numbers.join(',')
}
console.log(main())
