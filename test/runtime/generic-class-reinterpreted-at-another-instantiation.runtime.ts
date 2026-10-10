// A database client's cursors retype THEMSELVES: `AbstractCursor.map` composes a
// transform and returns `this as unknown as AbstractCursor<T>`, and
// `AggregationCursor.map` re-asserts `super.map(transform) as
// AggregationCursor<T>`. One object, viewed at several instantiations -- and
// the `transform` field, typed `(doc: TSchema) => any`, keeps receiving the
// RAW documents whatever `TSchema` the current view claims. The cast through
// `unknown` is the program declaring that relationship unchecked.
class AbstractCursor<TSchema = any> {
  private transform?: (doc: TSchema) => any
  constructor(private readonly docs: any[]) {}
  map<T = any>(transform: (doc: TSchema) => T): AbstractCursor<T> {
    const oldTransform = this.transform
    if (oldTransform) {
      this.transform = (doc) => {
        return transform(oldTransform(doc))
      }
    } else {
      this.transform = transform
    }
    return this as unknown as AbstractCursor<T>
  }
  toArray(): any[] {
    const transform = this.transform
    return this.docs.map((doc) => (transform ? transform(doc) : doc))
  }
}
class AggregationCursor<TSchema = any> extends AbstractCursor<TSchema> {
  override map<T>(transform: (doc: TSchema) => T): AggregationCursor<T> {
    return super.map(transform) as AggregationCursor<T>
  }
}
const raw = new AggregationCursor<{ n: number }>(JSON.parse('[{"n":1},{"n":2}]'))
const doubled = raw.map((doc) => doc.n * 2)
const labelled = doubled.map((n) => `#${n}`)
console.log(labelled.toArray().join(','), (raw as unknown) === labelled)

//! expect: #2,#4 true
