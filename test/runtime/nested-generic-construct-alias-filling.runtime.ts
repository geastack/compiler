// A database client's `Collection<TSchema>.find` constructs `FindCursor<WithId<TSchema>>`,
// where `WithId` is an alias over a conditional. Under each copy of
// `Collection` the filling closes to `WithId<DataKey>`, but the public checker
// API cannot instantiate the alias under that copy, so no `FindCursor` copy
// was minted at all and every cursor member was refused at emission.
//
// `find` is OVERLOADED, as the client's is, and no other member of `Collection`
// spells `WithId<TSchema>`: the overloads are the only place the closed image
// `WithId<DataKey>` can be read from.
type EnhancedOmit<TRecord, KeyUnion> = string extends keyof TRecord
  ? TRecord
  : TRecord extends any
    ? Pick<TRecord, Exclude<keyof TRecord, KeyUnion>>
    : never
type InferIdType<TSchema> = TSchema extends { _id: infer IdType } ? IdType : string
type WithId<TSchema> = EnhancedOmit<TSchema, '_id'> & { _id: InferIdType<TSchema> }

abstract class AbstractCursor<TSchema = any> {
  protected readonly buffer: TSchema[] = []
  constructor(readonly namespace: string) {}
}

class FindCursor<TSchema = any> extends AbstractCursor<TSchema> {
  load(rows: TSchema[]): void {
    for (const row of rows) this.buffer.push(row)
  }
  toArray(): TSchema[] {
    return this.buffer
  }
  count(): number {
    return this.buffer.length
  }
}

class Collection<TSchema> {
  constructor(readonly name: string) {}
  find(): FindCursor<WithId<TSchema>>
  find(filter: Partial<TSchema>): FindCursor<WithId<TSchema>>
  find(_filter: Partial<TSchema> = {}): FindCursor<WithId<TSchema>> {
    return new FindCursor<WithId<TSchema>>(this.name)
  }
}

class Db {
  collection<TSchema>(name: string): Collection<TSchema> {
    return new Collection<TSchema>(name)
  }
}

interface DataKey {
  _id: string
  name: string
  size: number
}
interface Note {
  _id: number
  text: string
}

const db = new Db()
const keys = db.collection<DataKey>('keys')
const keyCursor = keys.find()
keyCursor.load([{ _id: 'k1', name: 'alpha', size: 3 }])
console.log(keyCursor.count(), keyCursor.toArray()[0]?._id, keyCursor.toArray()[0]?.name)

const notes = db.collection<Note>('notes')
const noteCursor = notes.find({})
noteCursor.load([
  { _id: 7, text: 'hi' },
  { _id: 8, text: 'yo' }
])
console.log(noteCursor.count(), noteCursor.toArray()[1]?._id, noteCursor.toArray()[1]?.text, noteCursor.namespace)
//! expect: 1 k1 alpha
//! expect: 2 8 yo notes
