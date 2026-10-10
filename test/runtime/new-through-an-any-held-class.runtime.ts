// `new` THROUGH A CLASS HELD IN AN `any` SLOT CONSTRUCTS THAT CLASS.
//
// A database client's `ConnectionOptions` declares `connectionType?: any`, the pool
// stores `Connection` there, and `makeConnection` does
// `let ConnectionType = options.connectionType ?? Connection;
// return new ConnectionType(socket, options)`. The class crossed into a box
// and the runtime's `[[Construct]]` on a box only knew ordinary functions --
// it refused "a dynamic call reached a value that is not a callable" before
// the driver opened its first connection.

class Socket {
  constructor(readonly port: number) {}
}

class Conn {
  readonly label: string
  constructor(
    readonly socket: Socket,
    options: Options
  ) {
    this.label = `${options.name}:${socket.port}`
  }
}

class LoudConn extends Conn {}

class Options {
  constructor(
    readonly name: string,
    readonly connectionType?: any
  ) {}
}

function make(options: Options, socket: Socket): Conn {
  const ConnectionType = options.connectionType ?? Conn
  return new ConnectionType(socket, options)
}

const plain = make(new Options('a'), new Socket(1))
//! expect: a:1 Conn true
console.log(`${plain.label} ${plain.constructor.name} ${plain instanceof Conn}`)

const loud = make(new Options('b', LoudConn), new Socket(2))
//! expect: b:2 LoudConn true
console.log(`${loud.label} ${loud.constructor.name} ${loud instanceof LoudConn}`)
