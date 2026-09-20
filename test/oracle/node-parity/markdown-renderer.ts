function escapeHtml(input: string): string {
  return input.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
}

function emphasis(input: string): string {
  let out = ''
  let bold = false
  let italic = false
  let i = 0
  while (i < input.length) {
    if (i + 1 < input.length && input[i] === '*' && input[i + 1] === '*') {
      out += bold ? '</strong>' : '<strong>'
      bold = !bold
      i += 2
    } else if (input[i] === '_') {
      out += italic ? '</em>' : '<em>'
      italic = !italic
      i += 1
    } else {
      out += escapeHtml(input[i])
      i += 1
    }
  }
  if (italic) out += '</em>'
  if (bold) out += '</strong>'
  return out
}

function renderLines(lines: string[]): string {
  const html: string[] = []
  let listOpen = false

  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) {
      if (listOpen) {
        html.push('</ul>')
        listOpen = false
      }
    } else if (line.startsWith('## ')) {
      if (listOpen) {
        html.push('</ul>')
        listOpen = false
      }
      html.push('<h2>' + emphasis(line.slice(3)) + '</h2>')
    } else if (line.startsWith('# ')) {
      if (listOpen) {
        html.push('</ul>')
        listOpen = false
      }
      html.push('<h1>' + emphasis(line.slice(2)) + '</h1>')
    } else if (line.startsWith('- ')) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push('<li>' + emphasis(line.slice(2)) + '</li>')
    } else {
      if (listOpen) {
        html.push('</ul>')
        listOpen = false
      }
      html.push('<p>' + emphasis(line) + '</p>')
    }
  }

  if (listOpen) html.push('</ul>')
  return html.join('')
}

export function main(): string {
  const document = [
    '# Release Notes',
    '',
    'Ship **compiler** parity with _native_ output.',
    '',
    '## Highlights',
    '- Calculator app',
    '- Markdown & CSV checks',
    '- Escape <tags> safely'
  ]
  return renderLines(document)
}

console.log(main())
