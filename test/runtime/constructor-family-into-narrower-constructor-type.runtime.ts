// A database client hands `operation.SERVER_COMMAND_RESPONSE_TYPE` -- one of several
// response classes -- to `conn.command(..., responseType?:
// ServerReplyConstructor)`, a structural type stating `new (bytes,
// offset?, isArray?)` and a static `make`. The classes' own constructor takes
// a FOURTH optional parameter (`elements?`), which a caller of the declared
// type simply never passes. The command then builds its result with
// `(responseType ?? ServerResponse).make(bytes)`.
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
console.log(run(new Find(false)))
console.log(run(new Find(true)))
console.log(run(new Ping()))

//! expect: cursor:3 cursor:4
//! expect: explained:3 explained:4
//! expect: plain:3 undefined:undefined
