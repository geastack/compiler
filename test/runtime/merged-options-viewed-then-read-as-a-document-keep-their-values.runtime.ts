// A client merges its options into a fresh object (`Object.assign({}, a, b)`)
// and hands the merge on as a database's narrower options type, which in turn
// hands it to a helper typed `Record<string, any>` that copies the keys it
// allows. The narrower type is a live view of the merge, and a Document read
// of that view answers from the merge itself: every key must arrive with its
// value, not just its name.
export {}
interface DbOptions {
  readPreference?: string
  raw?: boolean
}
function filterOptions(options: Record<string, any>, names: readonly string[]): Record<string, any> {
  const filtered: Record<string, any> = {}
  for (const name in options) if (names.includes(name)) filtered[name] = options[name]
  return filtered
}
function dbOptionsOf(options: DbOptions): string {
  const filtered = filterOptions(options, ['readPreference', 'raw', 'session'])
  return Object.keys(filtered)
    .map((key) => key + '=' + String(filtered[key]))
    .join(' ')
}
const merged = Object.assign({}, { session: new Uint8Array([7]), readPreference: 'secondary', appName: 'app' }, { raw: true })
console.log(dbOptionsOf(merged))
console.log(dbOptionsOf({ readPreference: 'nearest', raw: false }))
//! expect: session=7 readPreference=secondary raw=true
//! expect: readPreference=nearest raw=false
