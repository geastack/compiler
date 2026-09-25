//! expect: 1 -1 2 true false
// `indexOf`/`includes` over a union element carrier (node's
// diagnostics_channel keys its registry by `string | symbol`): a value in one
// arm never equals a value in another, and two values in one arm compare by
// that arm's own rule.
const key = Symbol('key')
const names: (string | symbol)[] = ['a', key, 'b']
function find(name: string | symbol): number {
  return names.indexOf(name)
}
function has(name: string | symbol): boolean {
  return names.includes(name)
}
console.log(find(key), find('z'), find('b'), has('b'), has(Symbol('key')))
