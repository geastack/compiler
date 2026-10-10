// A database client's operations redeclare the options field their base
// declares with a wider options type:
//
//   class CommandOperation { options: CommandOperationOptions }
//   class FindOperation extends CommandOperation {
//     override options: FindOptions & { writeConcern?: never }
//   }
//
// In JavaScript the field holds the object that was stored, whatever the
// declared type of the class the reader names. The field's one slot used to be
// the base's record, so the store copied the value into that shape and a read
// through the subclass copied it back out, dropping `limit`, which only the
// subclass's type declares. The slot now holds every declaration's record as an
// arm (`override-field-arms.ts`), and a read tests which arm is live.
interface CommandOptions {
  comment?: string
  writeConcern?: { w: number }
}
interface FindOptions extends Omit<CommandOptions, 'writeConcern'> {
  limit?: number
}

class CommandOperation {
  options: CommandOptions
  constructor(options: CommandOptions) {
    this.options = options
  }
}

class FindOperation extends CommandOperation {
  override options: FindOptions & { writeConcern?: never }
  constructor(options: FindOptions) {
    super(options)
    this.options = { ...options }
  }
}

const options: FindOptions = { comment: 'c', limit: 2 }
const operation = new FindOperation(options)
//! expect: 2 2
console.log(options.limit, operation.options.limit)
