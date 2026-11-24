// A client merges its own options -- among them a TLS `session` held as bytes
// -- into a database's options and hands the merge to the database, which
// immediately reassigns its parameter to a filtered copy holding only the
// keys it allows. The read-preference helper then reads `session` as a
// client session object: it must see the filtered copy, which never has one,
// not the original merge whose `session` is a byte buffer.

export {}
class ClientSession {
  transaction = { options: { readPreference: 'from-transaction' } }
}
interface ReadPreferenceOptions {
  readPreference?: string
  session?: ClientSession
}
interface ClientOptions {
  session?: Uint8Array
  readPreference?: string
  appName: string
}
interface DbOptions {
  readPreference?: string
  raw?: boolean
}
const ALLOWED = ['readPreference', 'raw']
function filterOptions(options: Record<string, any>, names: readonly string[]): Record<string, any> {
  const filtered: Record<string, any> = {}
  for (const name in options) {
    if (names.includes(name)) filtered[name] = options[name]
  }
  return filtered
}
function readPreferenceOf(options?: ReadPreferenceOptions): string | undefined {
  if (!options) return undefined
  return options.readPreference ?? options.session?.transaction.options.readPreference
}
class Db {
  readPreference: string | undefined
  keys: string
  constructor(options?: DbOptions) {
    options = options ?? {}
    options = filterOptions(options, ALLOWED)
    this.readPreference = readPreferenceOf(options)
    this.keys = Object.keys(options).join(',')
  }
}
const client: ClientOptions = { session: new Uint8Array([1, 2]), readPreference: 'secondary', appName: 'app' }
const db = new Db(Object.assign({}, client, { raw: true }))
console.log(db.readPreference, db.keys)
const bare = new Db(Object.assign({}, { session: new Uint8Array([3]), appName: 'x' }, { raw: false }))
console.log(bare.readPreference, bare.keys)
console.log(readPreferenceOf({ session: new ClientSession() }))
//! expect: secondary readPreference,raw
//! expect: undefined raw
//! expect: from-transaction
