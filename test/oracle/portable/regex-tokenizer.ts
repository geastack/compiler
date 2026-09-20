interface Token {
  kind: string
  text: string
}

function classify(text: string): string {
  if (/^[0-9]+$/.test(text)) return 'num'
  if (/^(let|print)$/.test(text)) return 'kw'
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return 'id'
  return 'op'
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const pattern = /\s*(let|print|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|==|=|\+|;)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const text = match[1]
    tokens.push({ kind: classify(text), text })
  }
  return tokens
}

export function main(): string {
  const source = 'let total = price12 + 34; print total;'
  const tokens = tokenize(source)
  const encoded = tokens.map((token) => token.kind + ':' + token.text).join('|')
  const normalized = source.replace(/([A-Za-z_]+)([0-9]*)/g, (_full, word, digits) => {
    return String(word).toUpperCase() + (digits ? '#' + digits : '')
  })
  return encoded + ' normalized=' + normalized
}

console.log(main())
