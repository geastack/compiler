// A database client's `BulkWriteError` declares
// `writeErrors: OneOrMore<WriteError> = []`, where `OneOrMore<T> = T |
// ReadonlyArray<T>`. An array literal can only be the union's array arm, so
// the empty literal is built as an array of `WriteError` and widened into the
// union, rather than kept as an unstated `never[]`.
type OneOrMore<T> = T | ReadonlyArray<T>
class WriteError {
  constructor(readonly code: number) {}
}
class BulkError {
  writeErrors: OneOrMore<WriteError> = []
  describe(): string {
    const errors = this.writeErrors
    return errors instanceof WriteError ? 'one:' + errors.code : 'many:' + errors.length
  }
}
const a = new BulkError()
const b = new BulkError()
b.writeErrors = new WriteError(7)
//! expect: many:0 one:7
console.log(a.describe() + ' ' + b.describe())
