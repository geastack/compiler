// A class copy's member whose type is an intersection over a CONDITIONAL on
// the class's own parameter (a database client's `WithId<TSchema>` =
// `EnhancedOmit<TSchema, '_id'> & { _id: InferIdType<TSchema> }`), reached
// through another generic class's method result.
type Doc = { [key: string]: any }
type InferIdType<T> = T extends { _id: infer I } ? (Record<any, never> extends I ? never : I) : T extends { _id?: infer U } ? U : string
type EnhancedOmit<R, K> = string extends keyof R ? R : R extends any ? Pick<R, Exclude<keyof R, K>> : never
type WithId<T> = EnhancedOmit<T, '_id'> & { _id: InferIdType<T> }
class Cursor<T = any> {
  items: T[] = []
  async next(): Promise<T | null> {
    return this.items[0] ?? null
  }
  limit(count: number): this {
    this.items.length = Math.min(this.items.length, count)
    return this
  }
}
class Collection<T extends Doc = Doc> {
  limitless(): this {
    return this
  }
  find(): Cursor<WithId<T>>
  find(filter: Partial<T>): Cursor<WithId<T>>
  find<U extends Doc>(filter: Partial<T>): Cursor<U>
  find(filter: Partial<T> = {}): Cursor<WithId<T>> {
    const cursor = new Cursor<WithId<T>>()
    cursor.items.push({ _id: 'a1' } as WithId<T>)
    void filter
    return cursor
  }
  async findOne(filter: Partial<T> = {}): Promise<WithId<T> | null> {
    const { ...opts } = filter
    const cursor = this.find(opts).limit(1)
    const result = await cursor.next()
    return result
  }
}
interface DataKey {
  _id: string
  keyAltNames?: string[]
}
const key = await new Collection<DataKey>().limitless().findOne()
console.log(key?._id, key?.keyAltNames)
//! expect: a1 undefined
