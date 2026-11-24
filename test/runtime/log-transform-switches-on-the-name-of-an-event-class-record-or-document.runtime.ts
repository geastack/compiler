// A log transform takes an event that is one of several classes, a plain
// record type, or an arbitrary document, and switches on its `name`. Each
// event class states `name` as its own field initializer, the record states it
// as a member, and the document reads it dynamically; the switch must see the
// real name of whichever value arrives.

export {}
const STARTED = 'started' as const
const FAILED = 'failed' as const
const HEARTBEAT = 'heartbeat' as const
class SelectionEvent {
  constructor(public operation: string) {}
}
class StartedEvent extends SelectionEvent {
  name = STARTED
  message = 'Selection started'
}
class FailedEvent extends SelectionEvent {
  name = FAILED
  message = 'Selection failed'
  failure: Error
  constructor(operation: string, failure: Error) {
    super(operation)
    this.failure = failure
  }
}
type HeartbeatEvent = { name: typeof HEARTBEAT; connectionId: string; awaited: boolean }
type LoggableEvent = StartedEvent | FailedEvent | HeartbeatEvent

function transform(event: LoggableEvent | Record<string, any>): Record<string, any> {
  const log: Record<string, any> = Object.create(null)
  switch (event.name) {
    case STARTED:
    case FAILED:
      if (event instanceof SelectionEvent) log.operation = event.operation
      if (event instanceof StartedEvent) log.message = event.message
      if (event instanceof FailedEvent) log.failure = event.failure?.message
      return log
    case HEARTBEAT:
      log.connectionId = (event as HeartbeatEvent).connectionId
      log.awaited = (event as HeartbeatEvent).awaited
      return log
    default:
      for (const [key, value] of Object.entries(event)) log[key] = value
      return log
  }
}
const show = (log: Record<string, any>): string =>
  Object.keys(log)
    .map((key) => key + '=' + String(log[key]))
    .join(' ')
const events: (LoggableEvent | Record<string, any>)[] = [
  new StartedEvent('find'),
  new FailedEvent('insert', new Error('boom')),
  { name: HEARTBEAT, connectionId: 'c1', awaited: true },
  { name: 'custom', detail: 3 }
]
for (const event of events) console.log(show(transform(event)))
//! expect: operation=find message=Selection started
//! expect: operation=insert failure=boom
//! expect: connectionId=c1 awaited=true
//! expect: name=custom detail=3
