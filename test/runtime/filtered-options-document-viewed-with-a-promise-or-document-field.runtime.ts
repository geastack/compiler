// Options are filtered into a plain Document and assigned back to the typed
// options parameter, so the Document is viewed through the options interface.
// One field holds either a Document or a Promise; reading it through the view
// hands back the very promise (or Document) the entry holds.

export {}

type Document = { [key: string]: any }

interface ClientMetadata {
  name: string
}

interface Options {
  authSource?: string
  retryWrites?: boolean
  metadata?: Document | Promise<ClientMetadata>
}

function filterOptions(options: Document, names: ReadonlyArray<string>): Document {
  const filtered: Document = {}
  for (const name in options) {
    if (names.includes(name)) filtered[name] = options[name]
  }
  return filtered
}

class Db {
  readonly options?: Options
  constructor(options?: Options) {
    options = options ?? {}
    options = filterOptions(options, ['authSource', 'metadata'])
    this.options = options
  }
}

const metadata = Promise.resolve<ClientMetadata>({ name: 'driver' })
const db = new Db({ authSource: 'admin', retryWrites: true, metadata })
const plain = new Db({ metadata: { name: 'plain' } })
console.log(db.options?.authSource, db.options?.retryWrites, db.options?.metadata instanceof Promise)
const held = plain.options?.metadata
console.log(held !== undefined && !(held instanceof Promise) ? held.name : 'none')
const pending = db.options?.metadata
if (pending instanceof Promise) pending.then((value) => console.log(value.name))

//! expect: admin undefined true
//! expect: plain
//! expect: driver
