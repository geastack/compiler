// A census-built union parameter handed on to another function's
// census-built union parameter that holds FEWER arms: a database
// client's `resolveOptions(parent: OperationParent)` -- Client | Db | Collection
// | ... -- calling `resolveWireOptions(options, parent?: { wireOptions? })`,
// whose own callers passed only a Db or a Client. Every arm of the
// source must reach the call, the Collection included.

interface WireOptions {
  raw?: boolean
  promoteLongs?: boolean
}

class Client {
  s: { wireOptions: WireOptions } = { wireOptions: { raw: false, promoteLongs: true } }
  get wireOptions(): WireOptions {
    return this.s.wireOptions
  }
}

class Db {
  s: { wireOptions: WireOptions }
  constructor(client: Client) {
    this.s = { wireOptions: resolveWireOptions({ raw: true }, client) }
  }
  get wireOptions(): WireOptions {
    return this.s.wireOptions
  }
}

class Collection {
  s: { wireOptions: WireOptions }
  constructor(db: Db) {
    this.s = { wireOptions: resolveWireOptions({}, db) }
  }
  get wireOptions(): WireOptions {
    return this.s.wireOptions
  }
}

interface OperationParent {
  wireOptions?: WireOptions
  timeoutMS?: number
}

function resolveWireOptions(options?: WireOptions, parent?: { wireOptions?: WireOptions }): WireOptions {
  const parentOptions = parent?.wireOptions
  return {
    raw: options?.raw ?? parentOptions?.raw ?? false,
    promoteLongs: options?.promoteLongs ?? parentOptions?.promoteLongs ?? true
  }
}

function resolveOptions(parent: OperationParent | undefined, options?: WireOptions): WireOptions {
  return resolveWireOptions(options, parent)
}

const client = new Client()
const db = new Db(client)
const collection = new Collection(db)
const show = (options: WireOptions): string => `raw=${String(options.raw)} promoteLongs=${String(options.promoteLongs)}`
//! expect: collection raw=true promoteLongs=true
console.log(`collection ${show(resolveOptions(collection))}`)
//! expect: db raw=true promoteLongs=false
console.log(`db ${show(resolveOptions(db, { promoteLongs: false }))}`)
//! expect: client raw=false promoteLongs=true
console.log(`client ${show(resolveOptions(client))}`)
//! expect: record raw=true promoteLongs=true
console.log(`record ${show(resolveOptions({ wireOptions: { raw: true } }))}`)
