// A generic class whose own copies would share one layout -- their fillings
// are assignable to each other -- extending a base that splits on the same
// parameter. A database client's `ListCollectionsCursor<T> extends
// AbstractCursor<T>` is the case: held at `CollectionInfo` and at its default
// union, while `AbstractCursor` splits (its `transform` callback is typed by
// `TSchema`, and other cursors fill it with unrelated documents). One derived
// struct can extend only one base struct, so the derived class splits with its
// base, and `full.describe(...)` finds the base copy it really extends.
interface Info {
  name: string
  type: string
}
type Brief = Pick<Info, 'name'>

abstract class Cursor<T> {
  private transform?: (doc: T) => string
  map(fn: (doc: T) => string): this {
    this.transform = fn
    return this
  }
  describe(doc: T): string {
    return this.transform ? this.transform(doc) : 'raw'
  }
}

class Numbers extends Cursor<number> {}

class ListCursor<T extends Brief | Info = Brief | Info> extends Cursor<T> {
  constructor(public parent: string) {
    super()
  }
}

// Only ever held, never built: the driver's `Pick<CollectionInfo, ...>` copy
// in the probe. A copy that exists only as an annotation stores nothing, so it
// cannot force a split by itself -- the base's split has to.
export function briefName(cursor: ListCursor<Brief>): string {
  return cursor.describe({ name: 'x' })
}

const full = new ListCursor<Info>('db').map((doc) => doc.type)
const loose = new ListCursor<Info>('db')
const numbers = new Numbers().map((value) => String(value * 2))
console.log(full.describe({ name: 'a', type: 'view' }), loose.describe({ name: 'b', type: 'collection' }), numbers.describe(2), full.parent)
//! expect: view raw 4 db
