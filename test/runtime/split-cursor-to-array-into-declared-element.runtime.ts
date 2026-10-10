interface Doc {
  [key: string]: any
}
interface CollectionInfo extends Doc {
  name: string
  type?: string
  options?: Doc
}

abstract class AbstractCursor<TSchema = any> {
  transform?: (doc: TSchema) => unknown
  protected buffer: any[] = []
  constructor(docs: any[]) {
    this.buffer = docs
  }
  // A database client's own shape: the cursor is reinterpreted, not re-created, so every
  // copy of the family folds onto one class and `toArray` hands back `any[]`.
  map<T = any>(transform: (doc: TSchema) => T): AbstractCursor<T> {
    this.transform = transform
    return this as unknown as AbstractCursor<T>
  }
  async toArray(): Promise<TSchema[]> {
    const array: TSchema[] = []
    for (const doc of this.buffer) array.push(doc)
    return array
  }
}

class RunCommandCursor extends AbstractCursor {}
class FindCursor<TSchema = any> extends AbstractCursor<TSchema> {}
class ListCollectionsCursor<
  T extends Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo = Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo
> extends AbstractCursor<T> {
  constructor(
    readonly db: Db,
    readonly filter: Doc
  ) {
    super(db.docs)
  }
  clone(): ListCollectionsCursor<T> {
    return new ListCollectionsCursor(this.db, this.filter)
  }
}

class Db {
  constructor(readonly docs: any[]) {}
  listCollections(filter: Doc, options: { nameOnly: true }): ListCollectionsCursor<Pick<CollectionInfo, 'name' | 'type'>>
  listCollections(filter: Doc, options: { nameOnly: false }): ListCollectionsCursor<CollectionInfo>
  listCollections<
    T extends Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo = Pick<CollectionInfo, 'name' | 'type'> | CollectionInfo
  >(filter: Doc = {}, _options: { nameOnly?: boolean } = {}): ListCollectionsCursor<T> {
    return new ListCollectionsCursor<T>(this, filter)
  }
  find<T extends Doc>(): FindCursor<T> {
    return new FindCursor<T>(this.docs)
  }
}

async function options(db: Db): Promise<Doc | undefined> {
  const [collection] = await db.listCollections({ name: 'a' }, { nameOnly: false }).toArray()
  return collection?.options
}

async function names(db: Db): Promise<string[]> {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray()
  return collections.map(({ name }) => name)
}

// The rebuilt array is the only one: filling it must not reach the cursor's
// buffer or a later `toArray`, and the elements keep their own identity.
async function aliasing(db: Db): Promise<string> {
  const cursor = db.listCollections({}, { nameOnly: false })
  const first = await cursor.toArray()
  first.push({ name: 'z' })
  const second = await cursor.toArray()
  const options = first[0]!.options!
  options.seen = 1
  return `${first.length} ${second.length} ${db.docs.length} ${second[0]!.options!.seen}`
}

async function main() {
  // The documents are typed records held as `any`, which an element
  // assertion reads back by identity; a JSON-parsed dictionary (a database
  // client's wire documents) is adopted into the record instead.
  const docs: any[] = []
  const a: CollectionInfo = { name: 'a', type: 'collection', options: { capped: true } }
  const b: CollectionInfo = { name: 'b' }
  docs.push(a)
  docs.push(b)
  const db = new Db(docs)
  const raw = new RunCommandCursor(JSON.parse('[1,"x"]')).map((d) => d)
  const all = await raw.toArray()
  const found = await db.find<CollectionInfo>().toArray()
  console.log(all.length, found.length, JSON.stringify(await options(db)), (await names(db)).join('+'))
  console.log(await aliasing(db))
  const parsed = new Db(JSON.parse('[{"name":"j","options":{"capped":false}},{"name":"k","type":"view"}]'))
  console.log(JSON.stringify(await options(parsed)), (await names(parsed)).join('+'))
}
main()
//! expect: 2 2 {"capped":true} a+b
//! expect: 3 2 2 1
//! expect: {"capped":false} j+k
//! emitted-has: gea_rebuilt->appendRangeConverted
