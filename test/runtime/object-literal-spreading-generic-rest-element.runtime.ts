// A literal that spreads the element of a generic rest parameter: a database
// client's `emitAndLogHeartbeat<EventKey>(..., ...args: Parameters<Events[EventKey]>)`
// logs `{ topologyId, serverConnectionId, ...args[0] }`. In the generic body
// the checker types `args[0]` -- and so the whole literal -- `any`, but every
// copy closes it to one event class, so the literal is that copy's record:
// its written keys, then the event's own fields in `CopyDataProperties` order.
// Stored into the union of log shapes, the failed event's record fits both
// arms and takes the one that keeps its `duration` and `failure`.
class ServerHeartbeatStartedEvent {
  connectionId: string
  awaited: boolean
  name = 'serverHeartbeatStarted'
  constructor(connectionId: string, awaited: boolean) {
    this.connectionId = connectionId
    this.awaited = awaited
  }
}
class ServerHeartbeatFailedEvent {
  connectionId: string
  duration: number
  failure: Error
  awaited: boolean
  name = 'serverHeartbeatFailed'
  constructor(connectionId: string, duration: number, failure: Error, awaited: boolean) {
    this.connectionId = connectionId
    this.duration = duration
    this.failure = failure
    this.awaited = awaited
  }
}
type LoggableStarted = { topologyId: number; awaited: boolean; connectionId: string; name: string }
type LoggableFailed = { topologyId: number; awaited: boolean; connectionId: string; duration: number; failure: Error; name: string }
type Events = {
  started(event: ServerHeartbeatStartedEvent): void
  failed(event: ServerHeartbeatFailedEvent): void
}
interface LogConvertible extends Record<string, any> {
  toLog(): Record<string, any>
}
type Loggable = LoggableStarted | LoggableFailed | LogConvertible
class Logger {
  lines: string[] = []
  debug(component: string, message: Loggable | string): void {
    this.lines.push(typeof message === 'string' ? message : `${component}:${'duration' in message}:${'failure' in message}`)
  }
}
class Emitter<E extends Record<string, (...args: any[]) => void>> {
  logged: string[] = []
  clientLogger?: Logger = new Logger()
  emitAndLogHeartbeat<K extends keyof E>(
    event: K | symbol,
    topologyId: number,
    serverConnectionId?: number | '<monitor>',
    ...args: Parameters<E[K]>
  ): void {
    const loggable: LoggableStarted | LoggableFailed = {
      topologyId: topologyId,
      serverConnectionId: serverConnectionId ?? null,
      ...args[0]
    }
    this.logged.push(`${loggable.topologyId}:${loggable.connectionId}:${loggable.name}:${loggable.awaited}`)
    this.clientLogger?.debug('topology', loggable)
  }
}
const emitter = new Emitter<Events>()
emitter.emitAndLogHeartbeat('started', 1, 3, new ServerHeartbeatStartedEvent('c1', true))
emitter.emitAndLogHeartbeat('failed', 1, undefined, new ServerHeartbeatFailedEvent('c2', 5, new Error('x'), false))
console.log(emitter.logged.join(' '), emitter.clientLogger?.lines.join(' '))
//! expect: 1:c1:serverHeartbeatStarted:true 1:c2:serverHeartbeatFailed:false topology:false:false topology:true:true
