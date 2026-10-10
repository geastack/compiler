// ECMA-262 20.1.2.7 Object.fromEntries drains any iterable of entries. A
// database client builds `Object.fromEntries(indexes.map(({ name, key }) =>
// [name, ...]))` from an Array of pairs and `Object.fromEntries(map.entries())`
// from a Map iterator.

interface Index {
  name: string
  weight: number
}
const indexes: Index[] = [
  { name: 'a_1', weight: 1 },
  { name: 'b_1', weight: 2 },
  { name: 'a_1', weight: 3 }
]
const pairs: [string, number][] = indexes.map(({ name, weight }) => [name, weight])
const byName: Record<string, number> = Object.fromEntries(pairs)
//! expect: keys=a_1,b_1 a=3 b=2
console.log('keys=' + Object.keys(byName).join(',') + ' a=' + byName['a_1'] + ' b=' + byName['b_1'])

const defaults = new Map<string, string>()
defaults.set('w', 'majority')
defaults.set('appName', 'ping')
const options: Record<string, string> = Object.fromEntries(defaults.entries())
//! expect: options=w:majority,appName:ping
console.log(
  'options=' +
    Object.keys(options)
      .map((k) => k + ':' + options[k])
      .join(',')
)
