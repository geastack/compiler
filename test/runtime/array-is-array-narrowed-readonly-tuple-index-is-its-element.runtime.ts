// A trie router keys a child by `Array.isArray(pattern) ? pattern[0] :
// p`, where `pattern` is `readonly [string, string, RegExp | true] | '*' |
// null`. `Array.isArray` narrows it to the tuple arm, whose index 0 is a
// `string`: the key is a string, and the `in` test against the children
// dictionary is a native lookup that publishes nothing of the dictionary.
export {}

type Pattern = readonly [string, string, RegExp | true] | '*'

const cache: Record<string, Pattern> = {}
const patternOf = (label: string): Pattern | null => {
  if (label === '*') return '*'
  const match = label.match(/^:([^{]+)(?:\{(.+)\})?$/)
  if (!match) return null
  const name = match[1]!
  return (cache[label] ??= match[2] ? [label, name, new RegExp(`^${match[2]}$`)] : [label, name, true])
}

class Child {
  constructor(readonly label: string) {}
}

const children: Record<string, Child> = Object.create(null)
const seen: string[] = []
for (const part of ['users', ':id', ':id{[0-9]+}', '*', 'users', ':id']) {
  const pattern = patternOf(part)
  const key = Array.isArray(pattern) ? pattern[0] : part
  if (key in children) {
    seen.push(`=${key}`)
    continue
  }
  children[key] = new Child(key)
  seen.push(`+${key}`)
}
console.log(seen.join(' '), Object.keys(children).length)
//! expect: +users +:id +:id{[0-9]+} +* =users =:id 4
//! emitted-lacks: gea_unbox
