// A database client's `ReadConcern.fromOptions` again (`instanceof-class-record-string-
// union.ts`), with the rest of the client around it. The `{ level }` arm of
// `ReadConcernLike` can hold a view of a ReadConcern only if some conversion
// puts one there; the ones the client performs put nothing there:
// - an operation class upcast to its base, whose fields carry the union
//   (an upcast converts no field),
// - an options record converted into another options record type, whose
//   other fields hold class instances (fields convert key by key),
// - an operation class constructor passed as a `{ aspects?: ... }` record
//   (a constructor's parameter types are not values it holds),
// - a class instance boxed as `any` elsewhere, and a ReadConcern viewed as a
//   plain `{ level: string }` document (a different carrier from the arm).
const ReadConcernLevel = Object.freeze({ local: 'local', majority: 'majority' } as const)
type ReadConcernLevel = (typeof ReadConcernLevel)[keyof typeof ReadConcernLevel]

class ReadConcern {
  level: ReadConcernLevel | string
  constructor(level: ReadConcernLevel) {
    this.level = level
  }
  static fromOptions(options?: { readConcern?: ReadConcernLike; level?: ReadConcernLevel }): ReadConcern | undefined {
    if (options == null) return
    if (options.readConcern) {
      const { readConcern } = options
      if (readConcern instanceof ReadConcern) {
        return readConcern
      } else if (typeof readConcern === 'string') {
        return new ReadConcern(readConcern)
      } else if ('level' in readConcern && readConcern.level) {
        return new ReadConcern(readConcern.level)
      }
    }
    if (options.level) return new ReadConcern(options.level)
    return
  }
}

type ReadConcernLike = ReadConcern | { level: ReadConcernLevel } | ReadConcernLevel

class ClientSession {
  constructor(readonly id: number) {}
}

interface CommandOperationOptions {
  readConcern?: ReadConcernLike
  session?: ClientSession
  comment?: string
}

interface AggregateOptions {
  readConcern?: ReadConcernLike
  session?: ClientSession
  explain?: boolean
}

abstract class AbstractOperation {
  static aspects?: Set<symbol>
  readConcern?: ReadConcern
  session?: ClientSession
  constructor(options: CommandOperationOptions) {
    this.readConcern = ReadConcern.fromOptions(options)
    this.session = options.session
  }
  hasAspect(aspect: symbol): boolean {
    const ctor = this.constructor as { aspects?: Set<symbol> }
    return ctor.aspects?.has(aspect) ?? false
  }
}

class FindOperation extends AbstractOperation {}
class AggregateOperation extends AbstractOperation {
  constructor(readonly options: AggregateOptions) {
    super(options)
  }
}

function defineAspects(operation: { aspects?: Set<symbol> }, aspect: symbol): void {
  Object.defineProperty(operation, 'aspects', { value: new Set([aspect]), writable: false })
}
const READ = Symbol('READ')
defineAspects(FindOperation, READ)
defineAspects(AggregateOperation, READ)

function levelOf(operation: AbstractOperation): string {
  return operation.readConcern?.level ?? 'none'
}

function aggregateOptionsOf(options: CommandOperationOptions): AggregateOptions {
  return { readConcern: options.readConcern, session: options.session, explain: false }
}

function describe(document: { level: string }): string {
  return 'level=' + document.level
}

const boxed: any[] = []
const session = new ClientSession(7)
const majority = new ReadConcern('majority')
boxed.push(session, majority)

const find = new FindOperation({ readConcern: majority, session })
const fromString = new FindOperation({ readConcern: 'local' })
const fromRecord = new AggregateOperation(aggregateOptionsOf({ readConcern: { level: 'majority' }, session }))
const none = new AggregateOperation(aggregateOptionsOf({}))

//! expect: majority true local majority none
console.log(levelOf(find), find.readConcern === majority, levelOf(fromString), levelOf(fromRecord), levelOf(none))
//! expect: level=majority 2 7 true true
console.log(describe(majority), boxed.length, fromRecord.session?.id, find.hasAspect(READ), none.hasAspect(READ))
