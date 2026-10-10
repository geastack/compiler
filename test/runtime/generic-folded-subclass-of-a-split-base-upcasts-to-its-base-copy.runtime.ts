// A generic subclass whose own copies share ONE layout, deriving from a
// generic base whose copies split into one layout per filling: a database
// client's `ListCollectionsCursor<T> extends AbstractCursor<T>`, reached as
// `db.listCollections(filter, { nameOnly: false }).toArray()`. The subclass is one struct, and it derives from the
// base copy its canonical filling names; calling an inherited base method on
// it must upcast into THAT copy.
//
// Not yet: `listCollections`' implementation is only ever reached through its
// non-generic overloads, so no copy of it exists and its `new
// ListCollectionsCursor<T>` mints no constructed copy -- while the translator
// compiles that root body at `T`'s default. Both `ListCollectionsCursor` copies
// the census does see are annotations, so no canonical copy is chosen: each
// call site asks for the base copy its own written filling names, and the one
// struct's carrier names neither as an ancestor.
interface CollectionInfo {
  name: string
  type?: string
  options?: { capped?: boolean }
}

abstract class AbstractCursor<TSchema = any> {
  protected buffer: TSchema[] = []
  push(value: TSchema): number {
    return this.buffer.push(value)
  }
  toArray(): TSchema[] {
    return [...this.buffer]
  }
}

class ListCollectionsCursor<
  T extends Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo = Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo
> extends AbstractCursor<T> {
  constructor(readonly parent: string) {
    super()
  }
}

class Db {
  listCollections(filter: object, options: { nameOnly: true }): ListCollectionsCursor<Pick<CollectionInfo, 'name' | 'type'>>
  listCollections(filter: object, options: { nameOnly: false }): ListCollectionsCursor<CollectionInfo>
  listCollections<
    T extends Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo = Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo
  >(filter?: object, options?: { nameOnly?: boolean }): ListCollectionsCursor<T>
  listCollections<
    T extends Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo = Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo
  >(filter: object = {}, options: { nameOnly?: boolean } = {}): ListCollectionsCursor<T> {
    const cursor = new ListCollectionsCursor<T>(`db:${Object.keys(filter).length}:${options.nameOnly === true}`)
    cursor.push({ name: 'todos', type: 'collection' } as T)
    return cursor
  }
}

class FindCursor<TSchema> extends AbstractCursor<TSchema> {}

const counts = new FindCursor<number>()
counts.push(4)
const db = new Db()
const [info] = db.listCollections({ name: 'todos' }, { nameOnly: false }).toArray()
const names = db.listCollections({}, { nameOnly: true }).toArray()
console.log(info?.name, info?.options == null, names.length, names[0]?.type, counts.toArray().length)
//! expect: todos true 1 collection 1
