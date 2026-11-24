// A class instance read through a key that `Object.keys` produced and the
// program asserts to `keyof typeof MAP`: only the map's keys can arrive, so the
// read is the union of those fields' types even though the class has string
// and boolean fields beside them.

export {}

type Document = Record<string, any>

class QueryRequest {
  ns: string
  numberToSkip: number
  numberToReturn: number
  returnFieldSelector?: Document
  slaveOk: boolean
  constructor(ns: string, skip: number, limit: number, fields?: Document) {
    this.ns = ns
    this.numberToSkip = skip
    this.numberToReturn = limit
    if (fields) this.returnFieldSelector = fields
    this.slaveOk = false
  }
}

const LEGACY_FIND_OPTIONS_MAP = {
  numberToSkip: 'skip',
  numberToReturn: 'batchSize',
  returnFieldSelector: 'projection'
} as const

function extractCommand(command: QueryRequest): Document {
  const result: Document = { find: command.ns }
  Object.keys(LEGACY_FIND_OPTIONS_MAP).forEach((key) => {
    const legacyKey = key as keyof typeof LEGACY_FIND_OPTIONS_MAP
    if (command[legacyKey] != null) {
      result[LEGACY_FIND_OPTIONS_MAP[legacyKey]] = command[legacyKey]
    }
  })
  return result
}

console.log(JSON.stringify(extractCommand(new QueryRequest('db.items', 5, 10))))
console.log(JSON.stringify(extractCommand(new QueryRequest('db.users', 0, 1, { name: 1 }))))

//! expect: {"find":"db.items","skip":5,"batchSize":10}
//! expect: {"find":"db.users","skip":0,"batchSize":1,"projection":{"name":1}}
