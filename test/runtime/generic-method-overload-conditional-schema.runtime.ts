// An overloaded method of a generic class, read and called off an
// instantiated receiver from outside the class (a database client's `fetchKeys`:
// `client.db(n).collection<DataKey>(c).find(filter, options)`). The one
// physical frame is the implementation's, whose `Filter<T>`/`WithId<T>`
// conditionals only the receiver's class copy can close.
type Doc = { [key: string]: any }
type InferIdType<T> = T extends { _id: infer I } ? (Record<any, never> extends I ? never : I) : T extends { _id?: infer U } ? U : string
type EnhancedOmit<R, K> = string extends keyof R ? R : R extends any ? Pick<R, Exclude<keyof R, K>> : never
type WithId<T> = EnhancedOmit<T, '_id'> & { _id: InferIdType<T> }
type OptionalUnlessRequiredId<T> = T extends { _id: any } ? T : EnhancedOmit<T, '_id'> & { _id?: InferIdType<T> }
type Filter<T> = { [P in keyof WithId<T>]?: WithId<T>[P] }
class Collection<T extends Doc = Doc> {
  constructor(readonly name: string) {}
  docs: OptionalUnlessRequiredId<T>[] = []
  insertOne(doc: OptionalUnlessRequiredId<T>): void {
    this.docs.push(doc)
  }
  find(): number
  find(filter: Filter<T>, options?: { limit?: number }): number
  find<U extends Doc>(filter: Filter<U>, options?: { limit?: number }): number
  find(filter?: Filter<T>, options: { limit?: number } = {}): number {
    return filter === undefined ? this.docs.length : Math.min(this.docs.length, options.limit ?? 10)
  }
}
interface DataKey {
  _id: string
  keyAltNames?: string[]
}
const keys = new Collection<DataKey>('keys')
keys.insertOne({ _id: 'k1' })
console.log(keys.find({ _id: 'k1' }, {}), keys.find(), keys.docs[0]?._id)
//! expect: 1 1 k1
