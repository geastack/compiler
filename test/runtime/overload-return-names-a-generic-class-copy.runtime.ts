// An overload whose declared result names a generic class at a filling the
// implementation never writes: a database client's
// `Db.listCollections(filter, {nameOnly: false})` resolves to the overload returning
// `ListCollectionsCursor<CollectionInfo>`, while the implementation body
// constructs `new ListCollectionsCursor<T>(...)` at its own `T`. The cursor
// stores `T` through its base, so its fillings are separate layouts.
//
// The implementation is instantiated at the filling the resolved overload
// states for it -- its declared result, unified with the overload's -- so the
// object the body builds is the copy the caller holds.
interface Info {
  name: string
  type: string
}
type Brief = Pick<Info, 'name'>

abstract class Cursor<T> {
  protected buffer: T[] = []
  push(value: T): this {
    this.buffer.push(value)
    return this
  }
  toArray(): T[] {
    return this.buffer
  }
}

class ListCursor<T extends Brief | Info = Brief | Info> extends Cursor<T> {
  constructor(public parent: string) {
    super()
  }
}

interface Abortable {
  signal?: string
}
interface ListOptions extends Abortable {
  nameOnly?: boolean
  batchSize?: number
}

class Db {
  list(filter: object, options: Exclude<ListOptions, 'nameOnly'> & { nameOnly: true } & Abortable): ListCursor<Brief>
  list(filter: object, options: Exclude<ListOptions, 'nameOnly'> & { nameOnly: false } & Abortable): ListCursor<Info>
  list<T extends Brief | Info = Brief | Info>(filter?: object, options?: ListOptions & Abortable): ListCursor<T>
  list<T extends Brief | Info = Brief | Info>(_filter: object = {}, _options: ListOptions & Abortable = {}): ListCursor<T> {
    return new ListCursor<T>('db')
  }
}

class Collection {
  constructor(readonly db: Db) {}
  async options(options?: ListOptions): Promise<Info | undefined> {
    const [first] = this.db
      .list({ name: 'a' }, { ...options, nameOnly: false })
      .push({ name: 'a', type: 'collection' })
      .toArray()
    return first
  }
}

const db = new Db()
const full = db.list({}, { nameOnly: false }).push({ name: 'a', type: 'collection' })
const brief = db.list({}, { nameOnly: true }).push({ name: 'b' })
void new Collection(db).options().then((info) => console.log(info?.type))
const [first] = full.toArray()
console.log(first?.name, first?.type, brief.toArray().length, full.parent)
//! expect: a collection 1 db
//! expect: collection
