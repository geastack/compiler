// `Object.fromEntries` over pairs that widened to arrays resolves to the
// `Iterable<readonly any[]>` overload, which returns `any`; the annotated
// destination names the dictionary being built. A database client's
// `Collection.indexes({ full: false })` makes one exactly this way.

type Direction = 1 | -1 | 'text'
interface IndexInfo {
  name: string
  key: { [field: string]: Direction }
}
type Compact = Record<string, [name: string, direction: Direction][]>

const indexes: IndexInfo[] = [
  { name: '_id_', key: { _id: 1 } },
  { name: 'title_text', key: { title: 'text', created: -1 } }
]
const compact: Compact = Object.fromEntries(indexes.map(({ name, key }) => [name, Object.entries(key)]))
//! expect: keys=_id_,title_text
console.log('keys=' + Object.keys(compact).join(','))
//! expect: title_text=title:text,created:-1
console.log('title_text=' + compact['title_text']!.map(([field, direction]) => field + ':' + direction).join(','))
//! expect: _id_=_id:1
console.log('_id_=' + compact['_id_']!.map(([field, direction]) => field + ':' + direction).join(','))

// A pair whose key may be absent: ToPropertyKey(undefined) is "undefined".
interface MaybeNamed {
  name?: string
  size: number
}
const sized: MaybeNamed[] = [{ name: 'a', size: 1 }, { size: 2 }]
const bySize: Record<string, number> = Object.fromEntries(sized.map(({ name, size }) => [name, size]))
//! expect: bySize=a:1,undefined:2
console.log(
  'bySize=' +
    Object.entries(bySize)
      .map(([key, value]) => key + ':' + value)
      .join(',')
)
