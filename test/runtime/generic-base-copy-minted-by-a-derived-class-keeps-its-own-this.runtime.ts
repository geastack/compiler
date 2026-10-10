// `this` inside a generic class, in the copy a non-generic DERIVED class's
// `extends` clause mints: a database client's
// `ListSearchIndexesCursor extends AggregationCursor<{ name: string }>`, where
// `AggregationCursor`'s constructor does `this.pipeline = pipeline` and its
// `match()` returns `this.addStage(...)`. TypeScript's instantiated spelling of
// that heritage reference binds the polymorphic `this` to the derived class,
// but the copy's body is shared by every instance of that filling -- `this`
// there is the copy's own class, and a member it declares lives on it.
abstract class AbstractCursor<TSchema = any> {
  protected buffer: TSchema[] = []
  protected cursorOptions: { timeoutMS?: number } = {}
  initialized = false
  push(value: TSchema): number {
    return this.buffer.push(value)
  }
}

abstract class ExplainableCursor<TSchema> extends AbstractCursor<TSchema> {
  protected resolveExplain(verbosity?: string): string {
    return verbosity ?? 'queryPlanner'
  }
}

class AggregationCursor<TSchema = any> extends ExplainableCursor<TSchema> {
  readonly pipeline: object[]
  private aggregateOptions: { batchSize?: number }

  constructor(pipeline: object[] = [], options: { batchSize?: number } = {}) {
    super()
    this.pipeline = pipeline
    this.aggregateOptions = options
    const lastStage: object | undefined = this.pipeline[this.pipeline.length - 1]
    if (this.cursorOptions.timeoutMS != null && lastStage != null) throw new Error('bad')
  }

  addStage(stage: object): this {
    if (this.initialized) throw new Error('already initialized')
    this.pipeline.push(stage)
    return this
  }

  match(filter: object): this {
    return this.addStage({ $match: filter })
  }

  explain(verbosity?: string): string {
    return `${this.resolveExplain(verbosity)} ${this.pipeline.length} ${this.aggregateOptions.batchSize ?? 0} ${this.buffer.length}`
  }
}

interface Doc {
  name: string
}

class ListCursor<TSchema = any> extends AbstractCursor<TSchema> {
  limit = 0
}

class ListSearchIndexesCursor extends AggregationCursor<{ name: string }> {
  constructor(name: string | null) {
    super(name == null ? [{ $listSearchIndexes: {} }] : [{ $listSearchIndexes: { name } }])
  }
}

const search = new ListSearchIndexesCursor('idx')
search.push({ name: 'x' })
console.log(search.match({ q: 1 }).explain())
const docs = new AggregationCursor<Doc>([], { batchSize: 4 })
docs.push({ name: 'a' })
const counts = new ListCursor<number>()
counts.push(1)
counts.push(2)
console.log(docs.match({ a: 1 }).match({ b: 2 }).explain(), counts.limit)
//! expect: queryPlanner 2 0 1
//! expect: queryPlanner 2 4 1 0
