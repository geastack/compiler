type Token = { kind: 'number'; value: number } | { kind: 'operator'; value: string } | { kind: 'paren'; value: string }

const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ' ') {
      i += 1
    } else if (ch >= '0' && ch <= '9') {
      let raw = ''
      while (i < input.length && input[i] >= '0' && input[i] <= '9') {
        raw += input[i]
        i += 1
      }
      tokens.push({ kind: 'number', value: Number(raw) })
    } else if (ch === '(' || ch === ')') {
      tokens.push({ kind: 'paren', value: ch })
      i += 1
    } else {
      tokens.push({ kind: 'operator', value: ch })
      i += 1
    }
  }
  return tokens
}

function toPostfix(tokens: Token[]): Token[] {
  const output: Token[] = []
  const ops: string[] = []
  for (const token of tokens) {
    if (token.kind === 'number') output.push(token)
    else if (token.kind === 'operator') {
      while (ops.length > 0 && ops[ops.length - 1] !== '(' && precedence[ops[ops.length - 1]] >= precedence[token.value]) {
        output.push({ kind: 'operator', value: ops.pop() as string })
      }
      ops.push(token.value)
    } else if (token.value === '(') {
      ops.push(token.value)
    } else {
      while (ops.length > 0 && ops[ops.length - 1] !== '(') output.push({ kind: 'operator', value: ops.pop() as string })
      ops.pop()
    }
  }
  while (ops.length > 0) output.push({ kind: 'operator', value: ops.pop() as string })
  return output
}

function evalPostfix(tokens: Token[]): number {
  const stack: number[] = []
  for (const token of tokens) {
    if (token.kind === 'number') stack.push(token.value)
    else {
      const b = stack.pop() as number
      const a = stack.pop() as number
      if (token.value === '+') stack.push(a + b)
      else if (token.value === '-') stack.push(a - b)
      else if (token.value === '*') stack.push(a * b)
      else stack.push(Math.trunc(a / b))
    }
  }
  return stack[0]
}

export function main(): string {
  const programs = ['3 + 4 * 2', '( 8 + 2 ) * 5 - 9', '42 / 5 + 7 * 3', '18 - 6 / 2 + 4']
  const out: string[] = []
  for (const program of programs) {
    out.push(program + '=' + evalPostfix(toPostfix(tokenize(program))))
  }
  return out.join('|')
}

console.log(main())
