// A generic abstract base has one copy per result type, and one copy's every
// override leaves out the abstract method's trailing parameters (a database client's
// `FindOperation.buildCommandDocument()` under `CommandOperation<Document>`
// against the abstract `(connection, session?)`). The base's own call passes
// both arguments, so it holds the declaration's wider convention; each
// override must still be the body that runs, not the abstract stub.
interface Doc {
  [key: string]: any
}

class Connection {
  constructor(readonly name: string) {}
}

class Session {
  constructor(readonly id: number) {}
}

class Reply {
  constructor(readonly n: number) {}
  toObject(): Doc {
    return { n: this.n }
  }
}

abstract class Operation<TResult = any> {
  abstract get commandName(): string
  handleOk(reply: Reply): TResult {
    return reply.toObject() as TResult
  }
}

abstract class Command<T> extends Operation<T> {
  abstract buildCommandDocument(connection: Connection, session?: Session): Doc
  buildCommand(connection: Connection, session?: Session): Doc {
    const command = this.buildCommandDocument(connection, session)
    command.op = this.commandName
    return command
  }
}

class Find extends Command<Doc> {
  get commandName(): string {
    return 'find'
  }
  override buildCommandDocument(): Doc {
    return { find: 'items' }
  }
}

class Aggregate extends Command<Doc> {
  get commandName(): string {
    return 'aggregate'
  }
  override buildCommandDocument(): Doc {
    return { aggregate: 1 }
  }
}

class Count extends Command<number> {
  get commandName(): string {
    return 'count'
  }
  override buildCommandDocument(connection: Connection, session?: Session): Doc {
    return { count: connection.name, session: session === undefined ? -1 : session.id }
  }
  override handleOk(reply: Reply): number {
    return reply.n
  }
}

class Drop extends Command<boolean> {
  get commandName(): string {
    return 'drop'
  }
  override buildCommandDocument(connection: Connection): Doc {
    return { drop: connection.name }
  }
  override handleOk(_reply: Reply): boolean {
    return true
  }
}

const connection = new Connection('c1')
const commands: Command<unknown>[] = [new Find(), new Aggregate(), new Count(), new Drop()]
for (const command of commands) console.log(JSON.stringify(command.buildCommand(connection, new Session(3))))
console.log(`count=${new Count().handleOk(new Reply(7))} find=${JSON.stringify(new Find().handleOk(new Reply(8)))}`)
//! expect: {"find":"items","op":"find"}
//! expect: {"aggregate":1,"op":"aggregate"}
//! expect: {"count":"c1","session":3,"op":"count"}
//! expect: {"drop":"c1","op":"drop"}
//! expect: count=7 find={"n":8}
export {}
