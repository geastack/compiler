// The escaping twin of `constructor-family-into-narrower-constructor-type`.
// A database client's `Connection.command` cannot be narrowed to its callers' closed
// response family: `new ConnectionType(socket, options)` constructs a class
// read out of an options record, so no proof can enumerate every receiver of
// `.command`, and `responseType?: ServerResponseConstructor` stays the stated
// structural constructor type. The family therefore has to enter that slot as
// itself -- a checked construct-entry adapter that keeps the class evaluation
// as its environment -- and the stated static `make` is read back through the
// class the environment names.
class Reply {
  readonly size: number
  constructor(
    readonly bytes: Uint8Array,
    readonly offset = 0,
    readonly isArray = false,
    elements?: number[]
  ) {
    this.size = elements?.length ?? bytes.length - offset
  }
  static make(bytes: Uint8Array): Reply {
    return new this(bytes)
  }
  kind(): string {
    return 'plain'
  }
}
class CursorReply extends Reply {
  override kind(): string {
    return 'cursor'
  }
}
class ExplainedReply extends CursorReply {
  override kind(): string {
    return 'explained'
  }
}
type ReplyConstructor = {
  new (bytes: Uint8Array, offset?: number, isArray?: boolean): Reply
  make(bytes: Uint8Array): Reply
}
abstract class Operation {
  SERVER_COMMAND_RESPONSE_TYPE?: typeof Reply
}
class Find extends Operation {
  constructor(explain: boolean) {
    super()
    this.SERVER_COMMAND_RESPONSE_TYPE = explain ? ExplainedReply : CursorReply
  }
}
class Ping extends Operation {}
const command = (responseType?: ReplyConstructor): string => {
  const made = (responseType ?? Reply).make(new Uint8Array(3))
  const built = responseType ? new responseType(new Uint8Array(5), 1) : undefined
  return `${made.kind()}:${made.size} ${built?.kind()}:${built?.size}`
}
const run = (operation: Operation): string => command(operation.SERVER_COMMAND_RESPONSE_TYPE)
// Handing `command` to code this program cannot see leaves its callers open.
;(globalThis as unknown as { command?: typeof command }).command = command
console.log(run(new Find(false)))
console.log(run(new Find(true)))
console.log(run(new Ping()))

//! expect: cursor:3 cursor:4
//! expect: explained:3 explained:4
//! expect: plain:3 undefined:undefined
