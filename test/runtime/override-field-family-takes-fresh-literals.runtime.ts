// A class field redeclared down a hierarchy as successive members of ONE
// interface family (a database client's operations: `options: OperationOptions &
// Abortable`, `override options: CommandOperationOptions`, ...) holds one
// layout, so a fresh literal handed to a constructor -- `{ ...options, dbName }`
// -- is simply stored in it, and the object a caller passes by name keeps its
// identity through every constructor in the chain.
type Abortable = { signal?: string }
interface OperationOptions {
  session?: string
}
interface CommandOptions extends OperationOptions {
  dbName?: string
  comment?: string
}
interface AggregateOptions extends CommandOptions {
  allowDiskUse?: boolean
}

function describe(options: OperationOptions): string {
  return `session=${options.session ?? '-'}`
}

class Operation {
  options: OperationOptions & Abortable
  constructor(options: OperationOptions & Abortable = {}) {
    this.options = options
  }
  base(): string {
    return describe(this.options)
  }
}
class CommandOperation extends Operation {
  override options: CommandOptions
  constructor(options?: CommandOptions) {
    super(options ?? {})
    this.options = options ?? {}
  }
}
class AggregateOperation extends CommandOperation {
  override options: AggregateOptions
  constructor(db: string, options: AggregateOptions) {
    super({ ...options, dbName: db })
    this.options = { ...options, dbName: db }
  }
}

const named: CommandOptions = { session: 's1', comment: 'c' }
const command = new CommandOperation(named)
console.log(command.options === named, command.base(), command.options.comment)
const aggregate = new AggregateOperation('admin', { allowDiskUse: true, session: 's2' })
console.log(aggregate.options.dbName, aggregate.options.allowDiskUse, aggregate.base())
const empty = new CommandOperation()
console.log(empty.base(), empty.options.dbName === undefined)
//! expect: true session=s1 c
//! expect: admin true session=s2
//! expect: session=- true
export {}
