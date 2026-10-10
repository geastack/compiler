//! expect: b,c
//! expect: false false
//! expect: none 2

// A database client's `Client.db`: `Object.assign({}, this.options, options)`
// where `this.options` is an `any`-built options object (`parseOptions`
// starts from `Object.create(null)`) typed as an interface whose members are
// all required. The copy holds exactly the keys the sources hold -- a
// declared-but-never-written member is absent, not a present default value
// that a later `filterOptions`-style walk hands on as an object.

class ReadConcern {
  readonly level: string
  constructor(level: string) {
    this.level = level
  }
}

interface ClientOptions {
  readConcern: ReadConcern
  b: number
}

interface DbOptions {
  readConcern?: ReadConcern
  c?: number
}

function parseOptions(): ClientOptions {
  const clientOptions = Object.create(null)
  clientOptions.b = 1
  return clientOptions
}

function filterOptions(options: Record<string, any>, names: readonly string[]): Record<string, any> {
  const filtered: Record<string, any> = {}
  for (const name in options) {
    if (names.includes(name)) filtered[name] = options[name]
  }
  return filtered
}

const options = parseOptions()
const dbOptions: DbOptions = { c: 3 }
const finalOptions = Object.assign({}, options, dbOptions, { b: 2 })
console.log(Object.keys(finalOptions).sort().join(','))
console.log('readConcern' in finalOptions, Object.prototype.hasOwnProperty.call(finalOptions, 'readConcern'))
const filtered = filterOptions(finalOptions, ['readConcern', 'b']) as DbOptions & { b: number }
console.log((filtered.readConcern === undefined ? 'none' : filtered.readConcern.level) + ' ' + filtered.b)
