// A class copy filled with `WithId<File>` (an Omit-and-intersect mapped
// spelling) is returned where the copy filled with `StoredFile` is expected -- the
// file-bucket `find` of a database client. The two fillings name the same fields,
// so they must be one physical class, not two copies with no conversion.
type EnhancedOmit<T, K> = string extends keyof T ? T : T extends any ? Pick<T, Exclude<keyof T, K>> : never
type WithId<T> = EnhancedOmit<T, '_id'> & { _id: number }

interface StoredFile {
  _id: number
  name: string
}

class Cursor<TSchema> {
  docs: TSchema[] = []
  transform?: (doc: TSchema) => unknown
  push(doc: TSchema): this {
    this.docs.push(doc)
    return this
  }
}

class Collection<TSchema> {
  constructor(private readonly items: TSchema[]) {}
  find(): Cursor<WithId<TSchema>> {
    const cursor = new Cursor<WithId<TSchema>>()
    for (const item of this.items) cursor.push(item as WithId<TSchema>)
    return cursor
  }
}

const files = new Collection<StoredFile>([
  { _id: 1, name: 'a' },
  { _id: 2, name: 'b' }
])
const find = (): Cursor<StoredFile> => files.find()
const cursor = find()
console.log(cursor.docs.length, cursor.docs[1]?.name)

//! expect: 2 b
