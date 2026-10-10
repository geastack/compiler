// A class viewed as an interface whose field is itself a record the class
// holds under a DIFFERENT declared interface: a database client's
// `Collection.s` is a `CollectionPrivate` and `OperationParent` reads it as
// `s: { namespace: Namespace }`. No conversion turns one record into
// the other, but the field is a record the target field's shape views, so
// the view builds it one level down.
class Namespace {
  db: string
  collection?: string
  constructor(db: string, collection?: string) {
    this.db = db
    if (collection !== undefined) this.collection = collection
  }
}
class CollectionNamespace extends Namespace {
  override collection: string
  constructor(db: string, collection: string) {
    super(db, collection)
    this.collection = collection
  }
}
class ReadConcern {
  constructor(readonly level: string) {}
}
interface OperationParent {
  s: { namespace: Namespace }
  readConcern?: ReadConcern
  timeoutMS?: number
}
interface DbPrivate {
  namespace: Namespace
  options: { timeoutMS?: number }
}
interface CollectionPrivate {
  db: Db
  options: { timeoutMS?: number }
  namespace: CollectionNamespace
  readConcern?: ReadConcern
}
class Db {
  s: DbPrivate
  constructor(name: string) {
    this.s = { namespace: new Namespace(name), options: {} }
  }
  get readConcern(): ReadConcern | undefined {
    return undefined
  }
}
class Collection {
  s: CollectionPrivate
  constructor(db: Db, name: string, options: { timeoutMS?: number }) {
    this.s = { db, options, namespace: new CollectionNamespace(db.s.namespace.db, name), readConcern: new ReadConcern('local') }
  }
  get readConcern(): ReadConcern | undefined {
    return this.s.readConcern
  }
  get timeoutMS(): number | undefined {
    return this.s.options.timeoutMS
  }
}
function resolve(parent: OperationParent | undefined): string {
  const namespace = parent?.s.namespace
  return `${namespace?.db}.${namespace?.collection} ${parent?.readConcern?.level} ${parent?.timeoutMS}`
}
const db = new Db('app')
console.log(resolve(new Collection(db, 'users', { timeoutMS: 3 })))
console.log(resolve(new Collection(db, 'todos', {})), resolve(db), resolve(undefined))
//! expect: app.users local 3
//! expect: app.todos local undefined app.undefined undefined undefined undefined.undefined undefined undefined
