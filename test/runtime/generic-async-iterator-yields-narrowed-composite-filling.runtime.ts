// A generic cursor's async iterator yielding a value narrowed away from null,
// in the copy a generic COLLECTION mints with a composite filling: a database
// client's `Collection<TSchema>.find()` returns `new FindCursor<WithId<TSchema>>`,
// and `AbstractCursor`'s `async *[Symbol.asyncIterator]()` does
// `const document = await this.next(); if (document === null) return; yield document`.
// The yielded value is the narrowed `WithId<Document>`, one type however the
// copy spells it.
interface WireDocument {
  [key: string]: any
}
class ObjectId {
  constructor(readonly hex: string) {}
}
interface GridFSChunk {
  _id: ObjectId
  n: number
}
type EnhancedOmit<TRecordOrUnion, KeyUnion> = string extends keyof TRecordOrUnion
  ? TRecordOrUnion
  : TRecordOrUnion extends any
    ? Pick<TRecordOrUnion, Exclude<keyof TRecordOrUnion, KeyUnion>>
    : never
type InferIdType<TSchema> = TSchema extends { _id: infer IdType } ? IdType : ObjectId
type WithId<TSchema> = EnhancedOmit<TSchema, '_id'> & { _id: InferIdType<TSchema> }

abstract class AbstractCursor<TSchema = any> {
  protected documents: TSchema[] = []
  constructor(seed: TSchema[]) {
    this.documents = seed
  }
  async next(): Promise<TSchema | null> {
    return this.documents.shift() ?? null
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<TSchema, void, void> {
    while (true) {
      const document = await this.next()
      if (document === null) return
      yield document
    }
  }
}

class FindCursor<TSchema = any> extends AbstractCursor<TSchema> {}

class Collection<TSchema extends WireDocument = WireDocument> {
  constructor(private readonly seed: WithId<TSchema>[]) {}
  find(): FindCursor<WithId<TSchema>> {
    return new FindCursor<WithId<TSchema>>(this.seed)
  }
}

const run = async (): Promise<void> => {
  const collection = new Collection<GridFSChunk>([
    { _id: new ObjectId('a'), n: 1 },
    { _id: new ObjectId('b'), n: 2 }
  ])
  const seen: string[] = []
  for await (const doc of collection.find()) seen.push(`${doc._id.hex}:${doc.n}`)
  console.log(seen.join(' '))
}
void run()
//! expect: a:1 b:2
