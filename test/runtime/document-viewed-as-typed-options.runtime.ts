// An open `Document` (`{ [key: string]: any }`) handed where a typed options
// interface is declared IS that object, at another static type: a database client's
// `new Db(client, name, options?: DbOptions)` rebinds
// `options = filterOptions(options, DB_OPTIONS_ALLOW_LIST)`, and
// `filterOptions` returns a `Document`.
//
// A write through the typed name is a read through the Document and the other
// way round, and keys the interface does not name stay on the object. A
// snapshot copy would print `admin false`, `admin`, `true` instead.
interface WireDocument {
  [key: string]: any
}

interface DbOptions {
  authSource?: string
  retryWrites?: boolean
}

function filterOptions(options: WireDocument, names: readonly string[]): WireDocument {
  const filtered: WireDocument = {}
  for (const name in options) {
    if (names.includes(name)) filtered[name] = options[name]
  }
  return filtered
}

let seen: WireDocument = {}

function open(options?: DbOptions): DbOptions {
  const filtered = filterOptions(options ?? {}, ['authSource', 'retryWrites'])
  seen = filtered
  options = filtered
  return options!
}

const options = open({ authSource: 'admin', retryWrites: true })
console.log(options.authSource, seen.retryWrites)
seen.authSource = 'local'
console.log(options.authSource)
options.retryWrites = false
console.log(seen.retryWrites)
console.log(Object.keys(seen).join(','))
const back: WireDocument = options
console.log('same', back === seen)
//! expect: admin true
//! expect: local
//! expect: false
//! expect: authSource,retryWrites
//! expect: same true
//! emitted-has: gea::record::makeDocumentViewWithOrigin<
//! emitted-has: gea::dictionary::readDocumentField(
//! emitted-has: gea::dictionary::checkedPayloadEntry<std::string>
