// An object literal passed to a split generic class's method whose parameter
// is a mapped-and-intersected filter over the class's filling -- a database client's
// `collection.deleteOne({ _id: id })` with `filter: Filter<TSchema> = {}`.
// The literal takes the parameter's layout (a record with a string index),
// not a record of its own that no conversion reaches.
interface Doc {
  [key: string]: any
}
interface RootFilterOperators<TSchema> extends Doc {
  $comment?: string
}
type Filter<TSchema> = { [P in keyof TSchema]?: TSchema[P] } & RootFilterOperators<TSchema>

class Id {
  constructor(readonly value: number) {}
}

interface StoredFile {
  _id: Id
  name: string
}

class Collection<TSchema> {
  constructor(private readonly items: TSchema[]) {}
  async deleteOne(filter: Filter<TSchema> = {}): Promise<number> {
    const id: unknown = filter['_id']
    const before = this.items.length
    const kept = this.items.filter((item) => (item as { _id?: unknown })._id !== id)
    this.items.length = 0
    for (const item of kept) this.items.push(item)
    return before - this.items.length
  }
}

const a = new Id(1)
const files = new Collection<StoredFile>([
  { _id: a, name: 'a' },
  { _id: new Id(2), name: 'b' }
])
const main = async (): Promise<void> => {
  const id: Id = a
  const deleted = await files.deleteOne({ _id: id })
  console.log(deleted)
}
void main()

//! expect: 1
