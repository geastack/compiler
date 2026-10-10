// The first override of an abstract method leaves out the parameters it does
// not read; a later override reads them. The dispatch slot keeps the abstract
// signature's full parameter list (a database client's command operation's
// `buildCommandDocument`, overridden as `buildCommandDocument()` by its
// pipeline operation).
class Connection {
  constructor(readonly address: string) {}
}

abstract class Operation {
  abstract buildCommand(connection: Connection, session?: string): string

  run(connection: Connection, session?: string): string {
    return this.buildCommand(connection, session)
  }
}

class Aggregate extends Operation {
  override buildCommand(): string {
    return 'aggregate'
  }
}

class Delete extends Operation {
  override buildCommand(connection: Connection, session?: string): string {
    return `delete@${connection.address}${session === undefined ? '' : `#${session}`}`
  }
}

class Distinct extends Operation {
  override buildCommand(connection: Connection): string {
    return `distinct@${connection.address}`
  }
}

const connection = new Connection('db:27017')
const operations: Operation[] = [new Aggregate(), new Delete(), new Distinct()]
console.log(operations.map((operation) => operation.run(connection, 's1')).join(' '))
console.log(operations.map((operation) => operation.run(connection)).join(' '))
//! expect: aggregate delete@db:27017#s1 distinct@db:27017
//! expect: aggregate delete@db:27017 distinct@db:27017
export {}
