// A method of a generic base class is one body per class copy -- here
// `Operation<TResult>.handleOk` at `Doc`, `number` and `boolean` -- and a
// subclass overrides the copy its OWN heritage names, whatever convention the
// override states. A database client's `RunCursorCommandOperation extends
// RunCommandOperation` (so `Operation<Document>`) overrides
// `handleOk` to answer a `CursorResponse`, while `CountOperation extends
// CommandOperation<number>` answers a number; `executeOperation<T>` calls
// `operation.handleOk(result)` through a receiver typed as each operation
// class. The override belongs to the `Document` copy's family, and a
// `RunCommand` receiver holding a cursor command must run it.
interface Doc {
  [key: string]: any
}

class Reply {
  constructor(readonly n: number) {}
  toObject(): Doc {
    return { n: this.n }
  }
}

class CursorReply extends Reply {
  get batch(): number {
    return this.n * 10
  }
}

abstract class Operation<TResult = any> {
  abstract get commandName(): string
  handleOk(reply: Reply): TResult {
    return reply.toObject() as TResult
  }
}

abstract class Command<T> extends Operation<T> {
  abstract buildCommandDocument(): Doc
  buildCommand(): Doc {
    const command = this.buildCommandDocument()
    command.op = this.commandName
    return command
  }
}

class RunCommand<T = Doc> extends Operation<T> {
  get commandName(): string {
    return 'run'
  }
}

class RunCursorCommand extends RunCommand {
  override handleOk(reply: Reply): CursorReply {
    return reply instanceof CursorReply ? reply : new CursorReply(reply.n)
  }
}

class Count extends Command<number> {
  get commandName(): string {
    return 'count'
  }
  buildCommandDocument(): Doc {
    return { count: 'items' }
  }
  override handleOk(reply: Reply): number {
    return reply.n
  }
}

class Drop extends Command<boolean> {
  get commandName(): string {
    return 'drop'
  }
  buildCommandDocument(): Doc {
    return { drop: 'items' }
  }
  override handleOk(_reply: Reply): boolean {
    return true
  }
}

class Distinct extends Command<Doc> {
  get commandName(): string {
    return 'distinct'
  }
  buildCommandDocument(): Doc {
    return { distinct: 'items', key: 'k' }
  }
}

type ResultOf<T extends Operation> = ReturnType<T['handleOk']>

const execute = <T extends Operation>(operation: T, reply: Reply): ResultOf<T> => operation.handleOk(reply)

const plain: RunCommand = new RunCommand()
const cursor: RunCommand = new RunCursorCommand()
console.log('run=' + JSON.stringify(execute(plain, new Reply(1))))
const viewed = execute(cursor, new Reply(2)) as unknown as CursorReply
console.log('cursor=' + viewed.batch)
console.log('count=' + execute(new Count(), new Reply(3)) + ' drop=' + execute(new Drop(), new Reply(4)))
console.log('distinct=' + JSON.stringify(execute(new Distinct(), new Reply(5))))
const commands: Command<unknown>[] = [new Count(), new Drop(), new Distinct()]
console.log('built=' + commands.map((command) => JSON.stringify(command.buildCommand())).join(' '))
//! expect: run={"n":1}
//! expect: cursor=20
//! expect: count=3 drop=true
//! expect: distinct={"n":5}
//! expect: built={"count":"items","op":"count"} {"drop":"items","op":"drop"} {"distinct":"items","key":"k","op":"distinct"}
export {}
