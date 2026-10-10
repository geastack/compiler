// A method of a generic base called through `this` from two generic levels
// down, where the base STORES its type parameter and so really is one layout
// per filling: a database client's `FindCursor<TSchema> extends
// ExplainableCursor<TSchema> extends AbstractCursor<TSchema>`, whose
// `maxTimeMS` calls `this.throwIfInitialized()`. Each copy of the leaf must
// call the copy of the base it actually derives from.
abstract class AbstractCursor<TSchema = any> {
  protected buffer: TSchema[] = []
  initialized = false
  throwIfInitialized(): void {
    if (this.initialized) throw new Error('cursor is already initialized')
  }
  push(value: TSchema): number {
    return this.buffer.push(value)
  }
}

abstract class ExplainableCursor<TSchema> extends AbstractCursor<TSchema> {
  explain(): string {
    return `explain ${this.buffer.length}`
  }
}

class FindCursor<TSchema = any> extends ExplainableCursor<TSchema> {
  limit = 0
  maxTimeMS(value: number): this {
    this.throwIfInitialized()
    this.limit = value
    return this
  }
}

interface Doc {
  name: string
}

const docs = new FindCursor<Doc>()
docs.push({ name: 'a' })
const counts = new FindCursor<number>()
counts.push(1)
counts.push(2)
console.log(docs.maxTimeMS(5).limit, counts.maxTimeMS(9).limit, docs.explain(), counts.explain())
counts.initialized = true
try {
  counts.maxTimeMS(1)
} catch (error) {
  console.log((error as Error).message)
}
//! expect: 5 9 explain 1 explain 2
//! expect: cursor is already initialized
