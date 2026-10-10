//! expect: debug:command:false:commandStarted:1:ping:false:true:false debug:command:false:commandSucceeded:1:ping:true:true:false debug:direct:false:commandStarted:2:find:false:false:true
// A literal spreading a class instance, stored into a union whose only arm
// the literal fits is that CLASS: a database client's `emitAndLogCommand` logs
// `{ databaseName, ...args[0] }` as `CommandStartedEvent |
// LoggableCommandFailedEvent | LoggableCommandSucceededEvent`, and the
// started copy's literal is the event's own fields -- a plain object, never
// an instance (node: `instanceof` false, no `described` getter), so the
// class arm cannot hold it and the two record arms lack its `duration`.
//
// `semantics/normalize/record-stand-in-arms.ts` gives the literal's own
// record a STAND-IN arm in every union it reaches -- the binding, and `log`'s
// `Loggable | string`, which the bound `debug` shares by type identity -- and
// a per-read arm where a narrowing names the bare class. It is sound because
// no reachable narrowing can tell the record from the instance (a narrowing
// on a key the class and the record disagree on, `instanceof`, or an unknown
// `in` key withdraws it), and the arm is flagged so only the record's own
// shape moves into it: the succeeded copy's record must keep its `duration`
// in its own arm rather than being viewed into the stand-in.
//
// The file keeps its `-refused` name because callers pin it by path.
class StartedEvent {
  requestId: number
  commandName: string
  address: string
  connectionId?: string | number
  name = 'commandStarted'
  constructor(requestId: number, commandName: string, address: string) {
    this.requestId = requestId
    this.commandName = commandName
    this.address = address
  }
  get described(): string {
    return `${this.commandName}@${this.address}`
  }
}
class SucceededEvent {
  requestId: number
  commandName: string
  address: string
  duration: number
  reply: Record<string, number>
  name = 'commandSucceeded'
  constructor(requestId: number, commandName: string, address: string, duration: number) {
    this.requestId = requestId
    this.commandName = commandName
    this.address = address
    this.duration = duration
    this.reply = { ok: 1 }
  }
}
type LoggableSucceeded = {
  requestId: number
  commandName: string
  address: string
  duration: number
  reply: Record<string, number> | undefined
  name: string
  databaseName: string
}
type LoggableFailed = {
  requestId: number
  commandName: string
  address: string
  duration: number
  failure: Error
  name: string
  databaseName: string
}
interface LogConvertible extends Record<string, any> {
  toLog(): Record<string, any>
}
type Loggable = StartedEvent | LoggableSucceeded | LoggableFailed | LogConvertible
type Events = {
  started(event: StartedEvent): void
  succeeded(event: SucceededEvent): void
}
class Logger {
  lines: string[] = []
  debug = this.log.bind(this, 'debug')
  private log(severity: string, component: string, message: Loggable | string): void {
    if (typeof message === 'string') {
      this.lines.push(message)
      return
    }
    const convertible = (message as LogConvertible).toLog !== undefined
    const event = message as StartedEvent | LoggableSucceeded | LoggableFailed
    this.lines.push(
      `${severity}:${component}:${convertible}:${event.name}:${event.requestId}:${event.commandName}:${'duration' in event}:${'databaseName' in event}:${message instanceof StartedEvent}`
    )
  }
}
class Emitter<E extends Record<string, (...args: any[]) => void>> {
  logger?: Logger = new Logger()
  emitAndLogCommand<K extends keyof E>(event: K | symbol, databaseName: string, ...args: Parameters<E[K]>): void {
    const loggable: StartedEvent | LoggableFailed | LoggableSucceeded = {
      databaseName: databaseName,
      ...args[0]
    }
    this.logger?.debug('command', loggable)
  }
}
const emitter = new Emitter<Events>()
emitter.emitAndLogCommand('started', 'db1', new StartedEvent(1, 'ping', 'h:1'))
emitter.emitAndLogCommand('succeeded', 'db1', new SucceededEvent(1, 'ping', 'h:1', 4))
emitter.logger?.debug('direct', new StartedEvent(2, 'find', 'h:2'))
console.log(emitter.logger?.lines.join(' '))
