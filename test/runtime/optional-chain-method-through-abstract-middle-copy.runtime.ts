// A method of a split generic base called through an optional field holding a
// copy of a class two levels down: a database client's chunked-file read
// stream does `await this.s.cursor?.close(...)` with `cursor?: FindCursor<FileChunk>`,
// and `FindCursor<T> extends ExplainableCursor<T> extends AbstractCursor<T>`.
// The call's receiver is the `AbstractCursor` copy that `FindCursor<FileChunk>`
// really extends, through the abstract middle class's own copy.
abstract class AbstractCursor<TSchema = any> {
  private transform?: (doc: TSchema) => unknown
  map(fn: (doc: TSchema) => unknown): this {
    this.transform = fn
    return this
  }
  close(): string {
    return this.transform ? 'mapped' : 'closed'
  }
}
abstract class ExplainableCursor<TSchema> extends AbstractCursor<TSchema> {
  explain(): string {
    return 'plan'
  }
}
class FindCursor<TSchema = any> extends ExplainableCursor<TSchema> {}

interface Chunk {
  n: number
  data: string
}
class ReadStream {
  s: { cursor?: FindCursor<Chunk> } = {}
  abort(): string | undefined {
    return this.s.cursor?.close()
  }
}

const stream = new ReadStream()
console.log(stream.abort())
stream.s.cursor = new FindCursor<Chunk>().map((chunk) => chunk.n)
const names = new FindCursor<{ name: string }>()
console.log(stream.abort(), names.close(), names.explain())
//! expect: undefined
//! expect: mapped closed plan
