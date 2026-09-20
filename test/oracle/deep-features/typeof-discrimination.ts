//! oracle: node
function describe(x: number | string | boolean | null): string {
  if (typeof x === 'number') return 'num=' + x.toFixed(2)
  if (typeof x === 'string') return 'str=' + x.toUpperCase()
  if (typeof x === 'boolean') return 'bool=' + (x ? 'T' : 'F')
  return 'null'
}
export function main(): string {
  const inputs: (number | string | boolean | null)[] = [42, 'hello', true, null, 3.14, 'world', false]
  return inputs.map(describe).join('|')
}
console.log(main())
