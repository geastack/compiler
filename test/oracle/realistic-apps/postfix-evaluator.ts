//! oracle: node
export function main(): string {
  const program = '3 4 + 2 *'
  const stack: number[] = []
  const tokens = program.split(' ')
  for (const tok of tokens) {
    if (tok === '+' || tok === '-' || tok === '*' || tok === '/') {
      const b = stack.pop() as number
      const a = stack.pop() as number
      if (tok === '+') stack.push(a + b)
      else if (tok === '-') stack.push(a - b)
      else if (tok === '*') stack.push(a * b)
      else stack.push(a / b)
    } else {
      stack.push(Number(tok))
    }
  }
  return 'top=' + stack[stack.length - 1] + ' depth=' + stack.length
}
console.log(main())
