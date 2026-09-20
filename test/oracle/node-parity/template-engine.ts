interface Item {
  name: string
  qty: number
  price: number
}

interface Context {
  title: string
  user: string
  showCount: boolean
  items: Item[]
}

function escapeHtml(input: string): string {
  return input.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;')
}

function findTagClose(template: string, start: number): number {
  let i = start
  while (i + 1 < template.length) {
    if (template[i] === '}' && template[i + 1] === '}') return i
    i += 1
  }
  return template.length
}

function findSectionEnd(template: string, start: number, name: string): number {
  const marker = '{{/' + name + '}}'
  let i = start
  while (i + marker.length <= template.length) {
    let same = true
    for (let j = 0; j < marker.length; j++) {
      if (template[i + j] !== marker[j]) same = false
    }
    if (same) return i
    i += 1
  }
  return template.length
}

function endTagLength(name: string): number {
  return name.length + 5
}

function valueFor(tag: string, context: Context, item: Item, hasItem: boolean): string {
  if (tag === 'title') return context.title
  if (tag === 'user') return context.user
  if (tag === 'count') return '' + context.items.length
  if (hasItem && tag === 'name') return item.name
  if (hasItem && tag === 'qty') return '' + item.qty
  if (hasItem && tag === 'lineTotal') return '' + item.qty * item.price
  return ''
}

function renderRange(template: string, context: Context, item: Item, hasItem: boolean, start: number, end: number): string {
  let out = ''
  let i = start
  while (i < end) {
    if (i + 1 < end && template[i] === '{' && template[i + 1] === '{') {
      const close = findTagClose(template, i + 2)
      const tag = template.slice(i + 2, close).trim()
      const bodyStart = close + 2
      if (tag.startsWith('#')) {
        const name = tag.slice(1).trim()
        const bodyEnd = findSectionEnd(template, bodyStart, name)
        if (name === 'items') {
          for (const nextItem of context.items) out += renderRange(template, context, nextItem, true, bodyStart, bodyEnd)
        }
        i = bodyEnd + endTagLength(name)
      } else if (tag.startsWith('?')) {
        const name = tag.slice(1).trim()
        const bodyEnd = findSectionEnd(template, bodyStart, name)
        if (name === 'showCount' && context.showCount) {
          out += renderRange(template, context, item, hasItem, bodyStart, bodyEnd)
        }
        i = bodyEnd + endTagLength(name)
      } else if (tag.startsWith('/')) {
        i = end
      } else {
        out += escapeHtml(valueFor(tag, context, item, hasItem))
        i = bodyStart
      }
    } else {
      out += template[i]
      i += 1
    }
  }
  return out
}

function render(template: string, context: Context): string {
  const empty: Item = { name: '', qty: 0, price: 0 }
  return renderRange(template, context, empty, false, 0, template.length)
}

export function main(): string {
  const template =
    '<h1>{{title}}</h1><p>User: {{user}}</p>{{?showCount}}<p>Items: {{count}}</p>{{/showCount}}<ul>{{#items}}<li>{{name}} x{{qty}} = {{lineTotal}}</li>{{/items}}</ul>'
  const context: Context = {
    title: 'Order <draft>',
    user: 'Ada & Co',
    showCount: true,
    items: [
      { name: 'bolt', qty: 4, price: 3 },
      { name: 'gear "XL"', qty: 2, price: 11 },
      { name: 'plate <red>', qty: 1, price: 7 }
    ]
  }
  return render(template, context)
}

console.log(main())
