// A command document built by an abstract method whose every implementation
// returns a fresh literal, then given a key with `Object.assign`. The result
// is typed `Document`, a type an intrinsic could inhabit, but the object is
// one the program allocated, so the write cannot add the key to
// `Object.prototype`. A later read of that key through a parent that may
// lack it therefore still misses past the parent's own allocation.

export {}

type Document = { [key: string]: any }

abstract class CommandOperation {
  constructor(readonly level: number) {}
  abstract buildCommandDocument(name: string): Document
  buildCommand(name: string): Document {
    const command = this.buildCommandDocument(name)
    if (this.level > 0) Object.assign(command, { readConcern: { level: this.level } })
    return command
  }
}

class DropOperation extends CommandOperation {
  buildCommandDocument(name: string): Document {
    return { drop: name }
  }
}

class CountOperation extends CommandOperation {
  buildCommandDocument(name: string): Document {
    const cmd: Document = { count: name }
    if (name.length > 3) cmd.limit = name.length
    return cmd
  }
}

interface OperationParent {
  readConcern?: { level: number }
}

class Db implements OperationParent {
  readConcern = { level: 7 }
}

class Session {
  readonly id = 3
}

function resolveLevel(parent: OperationParent | undefined): number {
  return parent?.readConcern?.level ?? -1
}

const operations: CommandOperation[] = [new DropOperation(2), new CountOperation(0)]
for (const operation of operations) console.log(JSON.stringify(operation.buildCommand('things')))
console.log(resolveLevel(new Db()), resolveLevel(new Session() as OperationParent), resolveLevel(undefined))

//! expect: {"drop":"things","readConcern":{"level":2}}
//! expect: {"count":"things","limit":6}
//! expect: 7 -1 -1
