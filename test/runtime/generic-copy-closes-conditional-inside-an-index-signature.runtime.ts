// A generic class whose method returns a record holding a conditional type
// only inside an INDEX signature -- a database client's `insertMany` returns
// `InsertManyResult<TSchema>`, whose `insertedIds` is `{ [key: number]:
// InferIdType<TSchema> }`. The copy for a concrete schema reads the member's
// image off the checker's own instantiation, index signatures included, so the
// conditional is the type it evaluates to and not an unresolved hole.
class Key {
  constructor(readonly hex: string) {}
}
type IdOf<T> = T extends { id: infer I }
  ? Record<any, never> extends I
    ? never
    : I
  : T extends { id?: infer I }
    ? unknown extends I
      ? Key
      : I
    : Key
interface Result<T> {
  count: number
  ids: { [key: number]: IdOf<T> }
}
class Store<T> {
  held: { [key: number]: any } = {}
  add(position: number, id: unknown): void {
    this.held[position] = id
  }
  async result(): Promise<Result<T>> {
    return { count: Object.keys(this.held).length, ids: this.held }
  }
}
interface Named {
  id?: Key
  name: string
}
interface Plain {
  name: string
}
// Minted through a generic factory, as `db.collection<Todo>('todos')` is.
class Db {
  store<T>(): Store<T> {
    return new Store<T>()
  }
}
const db = new Db()
const named = db.store<Named>()
named.add(0, new Key('a'))
named.add(1, new Key('b'))
const plain = db.store<Plain>()
plain.add(0, new Key('c'))
const byName = await named.result()
const byPlain = await plain.result()
console.log(byName.count, byName.ids[0]?.hex, byName.ids[1]?.hex, byPlain.ids[0]?.hex)
//! expect: 2 a b c
export {}
