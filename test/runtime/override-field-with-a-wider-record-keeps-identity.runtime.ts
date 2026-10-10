// A database client's operation classes:
//
//   class AbstractOperation<TResult = unknown> { options: OperationOptions & Abortable }
//   class CommandOperation<T> extends AbstractOperation<T> { override options: CommandOperationOptions }
//   class CreateCollectionOperation extends CommandOperation<string> {
//     override options: CreateCollectionOptions
//     constructor(db, name, options = {}) { super(db, options); this.options = options }
//   }
//
// Three declarations, one property. JavaScript stores the object the program
// hands over, whichever class's declaration the write names: the field holds
// THAT object, every member of it, and a read through any class returns it.
// Generic, as that client's are: a class copy's members are laid out per copy.
interface Abortable {
  signal?: string
}
interface OperationOptions {
  session?: string
}
interface CommandOperationOptions extends OperationOptions {
  comment?: string
}
interface CreateCollectionOptions extends CommandOperationOptions {
  capped?: boolean
  size?: number
}

class AbstractOperation<TResult = unknown> {
  options: OperationOptions & Abortable
  constructor(options: OperationOptions & Abortable = {}) {
    this.options = options
  }
  sessionOf(): string {
    return this.options.session ?? 'none'
  }
  settle(result: TResult): TResult {
    return result
  }
}

class CommandOperation<T> extends AbstractOperation<T> {
  override options: CommandOperationOptions
  constructor(options?: CommandOperationOptions) {
    super(options)
    this.options = options ?? {}
  }
  commentOf(): string {
    return this.options.comment ?? 'none'
  }
}

class CreateCollectionOperation extends CommandOperation<string> {
  override options: CreateCollectionOptions
  constructor(options: CreateCollectionOptions = {}) {
    super(options)
    this.options = options
  }
  describe(): string {
    return `${this.options.capped} ${this.options.size}`
  }
}

const passed: CreateCollectionOptions = { session: 's', comment: 'c', capped: true, size: 64 }
const operation = new CreateCollectionOperation(passed)
//! expect: same true
console.log('same', operation.options === passed)
//! expect: members true 64 c s
console.log('members', operation.options.capped, operation.options.size, operation.commentOf(), operation.sessionOf())
//! expect: describe true 64
console.log('describe', operation.describe())
// A write through the options object is a write to the one object.
passed.size = 128
//! expect: after 128
console.log('after', operation.options.size)
const plain = new CommandOperation<number>({ comment: 'only' })
//! expect: settled 7 x
console.log('settled', plain.settle(7), operation.settle('x'))
//! expect: plain only none
console.log('plain', plain.commentOf(), plain.sessionOf())
