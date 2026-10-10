// A copy of a generic class handed where the program spells the class at its
// `any` default: a database client's `AbstractCursor<TSchema>.stream()` does
// `new ReadableCursorStream(this)`, whose parameter is a bare `AbstractCursor`
// (= `AbstractCursor<any>`), and `trackCursor` adds `this` to a
// `Set<AbstractCursor>`. `AbstractCursor` stores `TSchema` (its `transform`
// callback), and the program constructs it at several fillings, so its copies
// are separate layouts -- and the `any` copy is constructed too
// (`RunCommandCursor extends AbstractCursor`).
//
// In JavaScript this is one object. Natively the `any` copy is its own struct,
// and a copy of a mutable instance would lose writes and identity. `any` is
// the unchecked top, so a slot spelled `AbstractCursor` carries "any copy of
// this class" -- the sum of its layouts -- and each member access dispatches
// to the copy that is live. `this` and the class's own construction still
// name exactly their copy.
abstract class AbstractCursor<TSchema = any> {
  private transform?: (doc: TSchema) => unknown
  protected buffer: TSchema[] = []
  push(value: TSchema): this {
    this.buffer.push(value)
    return this
  }
  map(transform: (doc: TSchema) => unknown): this {
    this.transform = transform
    return this
  }
  bufferedCount(): number {
    return this.buffer.length
  }
  first(): unknown {
    const head = this.buffer[0]
    return head === undefined ? null : this.transform ? this.transform(head) : head
  }
  stream(): ReadableCursorStream {
    return new ReadableCursorStream(this)
  }
}

class ReadableCursorStream {
  constructor(private readonly cursor: AbstractCursor) {}
  describe(): string {
    return `${this.cursor.bufferedCount()}:${String(this.cursor.first())}`
  }
}

class RunCommandCursor extends AbstractCursor {}
class FindCursor<TSchema> extends AbstractCursor<TSchema> {}

const names = new FindCursor<{ name: string }>().push({ name: 'a' }).map((doc) => doc.name.toUpperCase())
const counts = new FindCursor<number>().push(3).push(4)
const raw = new RunCommandCursor().push('x')
console.log(names.stream().describe(), counts.stream().describe(), raw.stream().describe())
//! expect: 1:A 2:3 1:x
