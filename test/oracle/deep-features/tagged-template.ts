//! oracle: node
function fmt(strings: TemplateStringsArray, ...values: number[]): string {
  const parts: string[] = []
  for (let i = 0; i < strings.length; i++) {
    parts.push(strings[i])
    if (i < values.length) parts.push('<' + values[i].toFixed(1) + '>')
  }
  return parts.join('')
}
export function main(): string {
  const x = 3
  const y = 4
  const plain = `plain: ${x} + ${y} = ${x + y}`
  const tagged = fmt`tagged: ${x} and ${y} sum ${x + y}`
  return plain + ' || ' + tagged
}
console.log(main())
