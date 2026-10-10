// `Array.prototype.flat` spreads each element that IsArray -- a tuple is one
// -- so a database client's default index name `Array.from(key).flat().join('_')` over a
// `Map<string, IndexDirection>` interleaves every key with its direction. Its
// `indexes({ full: false })` builds `Object.fromEntries(indexes.map(({ name,
// key }) => [name, Object.entries(key)]))`.

type IndexDirection = -1 | 1 | '2d' | 'text' | number

const key = new Map<string, IndexDirection>()
key.set('a', 1)
key.set('loc', '2d')
//! expect: name=a_1_loc_2d
console.log('name=' + Array.from(key).flat().join('_'))

interface IndexInfo {
  name: string
  key: { [field: string]: IndexDirection }
}
const infos: IndexInfo[] = [
  { name: 'a_1', key: { a: 1 } },
  { name: 'b_-1_t_text', key: { b: -1, t: 'text' } }
]
type Compact = Record<string, [name: string, direction: IndexDirection][]>
const compact: Compact = Object.fromEntries(infos.map(({ name, key }) => [name, Object.entries(key)]))
//! expect: compact=a_1:a=1|b_-1_t_text:b=-1,t=text
console.log(
  'compact=' +
    Object.keys(compact)
      .map((k) => k + ':' + (compact[k] ?? []).map(([f, d]) => f + '=' + d).join(','))
      .join('|')
)
