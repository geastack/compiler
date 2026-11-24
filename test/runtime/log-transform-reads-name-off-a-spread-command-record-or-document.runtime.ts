// A database driver's logger: events are classes, records, or arbitrary
// log-convertible documents. `log` sends everything that is not
// log-convertible to the default transform, which switches on `event.name`.
// A command event is spread into a literal stated as a union of loggable
// records (`{ databaseName, ...args[0] }`), so that literal is a live view of
// a record arm -- and the transform's receiver unions those view-target
// records with the event classes and a `Record<string, any>` document, whose
// entry read is a Value.
const HEARTBEAT_STARTED = 'heartbeatStarted' as const
const HEARTBEAT_FAILED = 'heartbeatFailed' as const
const POOL_CREATED = 'poolCreated' as const
const POOL_CLOSED = 'poolClosed' as const
const CONN_CHECKED_IN = 'connCheckedIn' as const
const CONN_CHECKED_OUT = 'connCheckedOut' as const
const CONN_CHECKOUT_STARTED = 'connCheckoutStarted' as const
const CONN_CREATED = 'connCreated' as const
const CONN_READY = 'connReady' as const
const CONN_CLOSED = 'connClosed' as const
const CONN_POOL_READY = 'connPoolReady' as const
const COMMAND_STARTED = 'commandStarted' as const
const COMMAND_SUCCEEDED = 'commandSucceeded' as const

abstract class PoolEvent {
  abstract name: string
  constructor(public address: string) {}
}
class PoolCreatedEvent extends PoolEvent {
  name = POOL_CREATED
  options = { maxPoolSize: 10 }
}
class PoolClosedEvent extends PoolEvent {
  name = POOL_CLOSED
}
class ConnCheckedInEvent extends PoolEvent {
  name = CONN_CHECKED_IN
}
class ConnCheckedOutEvent extends PoolEvent {
  name = CONN_CHECKED_OUT
}
class ConnCheckoutStartedEvent extends PoolEvent {
  name = CONN_CHECKOUT_STARTED
}
class ConnCreatedEvent extends PoolEvent {
  name = CONN_CREATED
}
class ConnReadyEvent extends PoolEvent {
  name = CONN_READY
}
class ConnClosedEvent extends PoolEvent {
  name = CONN_CLOSED
}
class ConnPoolReadyEvent extends PoolEvent {
  name = CONN_POOL_READY
}
class CommandStartedEvent {
  serviceId?: string
  name = COMMAND_STARTED
  constructor(
    public commandName: string,
    public address: string
  ) {}
  get hasServiceId(): boolean {
    return !!this.serviceId
  }
}
class CommandSucceededEvent {
  name = COMMAND_SUCCEEDED
  constructor(
    public commandName: string,
    public duration: number
  ) {}
}
type LoggableCommandStarted = { databaseName: string; commandName: string; address: string; name: typeof COMMAND_STARTED }
type LoggableCommandSucceeded = { databaseName: string; commandName: string; duration: number; name: typeof COMMAND_SUCCEEDED }
type LoggableHeartbeatStarted = { topologyId: number; connectionId: string; awaited: boolean; name: typeof HEARTBEAT_STARTED }
type LoggableHeartbeatFailed = { topologyId: number; connectionId: string; failure: Error; name: typeof HEARTBEAT_FAILED }
type PoolEvents =
  | PoolCreatedEvent
  | PoolClosedEvent
  | ConnCheckedInEvent
  | ConnCheckedOutEvent
  | ConnCheckoutStartedEvent
  | ConnCreatedEvent
  | ConnReadyEvent
  | ConnClosedEvent
  | ConnPoolReadyEvent
type LoggableEvent = PoolEvents | LoggableCommandStarted | LoggableCommandSucceeded | LoggableHeartbeatStarted | LoggableHeartbeatFailed
interface LogConvertible extends Record<string, any> {
  toLog(): Record<string, any>
}
type Loggable = LoggableEvent | LogConvertible

// The driver spells this `(obj as LogConvertible).toLog !== undefined`; an
// `as T` is a checked arm projection here, so the guard asks `in` instead.
function isLogConvertible(obj: Loggable): obj is LogConvertible {
  return 'toLog' in obj && typeof obj.toLog === 'function'
}

function defaultLogTransform(logObject: LoggableEvent | Record<string, any>): Record<string, any> {
  let log: Record<string, any> = Object.create(null)
  switch (logObject.name) {
    case HEARTBEAT_STARTED:
      log.topologyId = logObject.topologyId
      log.awaited = logObject.awaited
      return log
    case HEARTBEAT_FAILED:
      log.topologyId = logObject.topologyId
      log.failure = logObject.failure?.message
      return log
    case COMMAND_STARTED:
      log.commandName = logObject.commandName
      log.message = 'Command started'
      return log
    case COMMAND_SUCCEEDED:
      log.commandName = logObject.commandName
      log.durationMS = logObject.duration
      return log
    case POOL_CREATED:
      log.address = logObject.address
      if (logObject.options) log = { ...log, maxPoolSize: logObject.options.maxPoolSize }
      return log
    case POOL_CLOSED:
    case CONN_CHECKED_IN:
    case CONN_CHECKED_OUT:
    case CONN_CHECKOUT_STARTED:
    case CONN_CREATED:
    case CONN_READY:
    case CONN_CLOSED:
    case CONN_POOL_READY:
      log.address = logObject.address
      return log
    default:
      for (const [key, value] of Object.entries(logObject)) log[key] = value
      return log
  }
}

class Logger {
  lines: string[] = []
  log(component: string, message: Loggable | string): void {
    let logMessage: Record<string, any> = { c: component }
    if (typeof message === 'string') logMessage.message = message
    else if (typeof message === 'object') {
      if (isLogConvertible(message)) logMessage = { ...logMessage, ...message.toLog() }
      else logMessage = { ...logMessage, ...defaultLogTransform(message) }
    }
    this.lines.push(
      Object.keys(logMessage)
        .map((key) => key + '=' + String(logMessage[key]))
        .join(' ')
    )
  }
  debug(component: string, message: Loggable | string): void {
    this.log(component, message)
  }
}

type CommandEvents = {
  started(event: CommandStartedEvent): void
  succeeded(event: CommandSucceededEvent): void
}
interface EventsDescription {
  [event: string]: (...args: any[]) => void
}
class Emitter<Events extends EventsDescription> {
  constructor(readonly logger: Logger) {}
  emitAndLog(event: PoolEvents): void {
    this.logger.debug('pool', event)
  }
  emitAndLogCommand<K extends keyof Events>(databaseName: string, ...args: Parameters<Events[K]>): void {
    const loggable: LoggableCommandStarted | LoggableCommandSucceeded = { databaseName, ...args[0] }
    this.logger.debug('command', loggable)
  }
}

const logger = new Logger()
class Connection extends Emitter<CommandEvents> {}
const emitter = new Connection(logger)
emitter.emitAndLog(new PoolCreatedEvent('a:1'))
emitter.emitAndLog(new PoolClosedEvent('a:1'))
emitter.emitAndLog(new ConnReadyEvent('b:2'))
emitter.emitAndLog(new ConnCheckedInEvent('b:3'))
emitter.emitAndLog(new ConnCheckedOutEvent('b:4'))
emitter.emitAndLog(new ConnCheckoutStartedEvent('b:5'))
emitter.emitAndLog(new ConnCreatedEvent('b:6'))
emitter.emitAndLog(new ConnClosedEvent('b:7'))
emitter.emitAndLog(new ConnPoolReadyEvent('b:8'))
logger.debug('topology', { topologyId: 4, connectionId: 'c1', awaited: true, name: HEARTBEAT_STARTED })
logger.debug('topology', { topologyId: 4, connectionId: 'c1', failure: new Error('boom'), name: HEARTBEAT_FAILED })
emitter.emitAndLogCommand<'started'>('app', new CommandStartedEvent('find', 'a:1'))
emitter.emitAndLogCommand<'succeeded'>('app', new CommandSucceededEvent('find', 3))
logger.debug('client', 'hello')
logger.debug('client', { toLog: () => ({ custom: 1 }) })
for (const line of logger.lines) console.log(line)

//! expect: c=pool address=a:1 maxPoolSize=10
//! expect: c=pool address=a:1
//! expect: c=pool address=b:2
//! expect: c=pool address=b:3
//! expect: c=pool address=b:4
//! expect: c=pool address=b:5
//! expect: c=pool address=b:6
//! expect: c=pool address=b:7
//! expect: c=pool address=b:8
//! expect: c=topology topologyId=4 awaited=true
//! expect: c=topology topologyId=4 failure=boom
//! expect: c=command commandName=find message=Command started
//! expect: c=command commandName=find durationMS=3
//! expect: c=client message=hello
//! expect: c=client custom=1
