// A collection, a database and a plain parent record all reach one options
// resolver as its parent. The collection exposes its serialization options and
// its namespace state through getters and a private-state record whose
// namespace is a subclass of the declared one; the resolver reads them through
// a structural parent interface, and hands the same parent on to a narrower
// one that names only the serialization options.

export {}
interface SerializeOptions {
  raw?: boolean
  promoteLongs?: boolean
}
class Namespace {
  constructor(
    readonly db: string,
    readonly collection?: string
  ) {}
  toString(): string {
    return this.collection === undefined ? this.db : `${this.db}.${this.collection}`
  }
}
class CollectionNamespace extends Namespace {
  constructor(db: string, collection: string) {
    super(db, collection)
  }
}
interface CollectionPrivate {
  namespace: CollectionNamespace
  options: SerializeOptions
}
class Db {
  s: { namespace: Namespace; options: SerializeOptions }
  constructor(name: string) {
    this.s = { namespace: new Namespace(name), options: { raw: false } }
  }
  get bsonOptions(): SerializeOptions {
    return this.s.options
  }
  get timeoutMS(): number | undefined {
    return 10
  }
}
class Collection<TSchema extends object = object> {
  s: CollectionPrivate
  marker?: TSchema
  constructor(db: Db, name: string) {
    this.s = { namespace: new CollectionNamespace(db.s.namespace.db, name), options: { promoteLongs: false } }
  }
  get bsonOptions(): SerializeOptions {
    return this.s.options
  }
  get timeoutMS(): number | undefined {
    return undefined
  }
  find(): string {
    return resolveOptions(this, { raw: true })
  }
}
interface OperationParent {
  s: { namespace: Namespace }
  bsonOptions?: SerializeOptions
  timeoutMS?: number
}
function resolveSerialize(options?: SerializeOptions, parent?: { bsonOptions?: SerializeOptions }): string {
  const inherited = parent?.bsonOptions
  return `raw=${options?.raw ?? inherited?.raw ?? false} longs=${options?.promoteLongs ?? inherited?.promoteLongs ?? true}`
}
function resolveOptions(parent: OperationParent | undefined, options?: SerializeOptions): string {
  const timeout = parent?.timeoutMS ?? 0
  const namespace = parent === undefined ? '-' : parent.s.namespace.toString()
  return `${namespace} ${timeout} ${resolveSerialize(options, parent)}`
}
const db = new Db('app')
const collection = new Collection<{ name: string }>(db, 'todos')
const record: OperationParent = { s: { namespace: new Namespace('admin') }, bsonOptions: { raw: true }, timeoutMS: 5 }
console.log(collection.find())
console.log(resolveOptions(db, {}))
console.log(resolveOptions(record))
console.log(resolveOptions(undefined, { promoteLongs: true }))
console.log(resolveSerialize(undefined, db), resolveSerialize({}, { bsonOptions: { promoteLongs: false } }))
//! expect: app.todos 0 raw=true longs=false
//! expect: app 10 raw=false longs=true
//! expect: admin 5 raw=true longs=true
//! expect: - 0 raw=false longs=true
//! expect: raw=false longs=true raw=false longs=false
