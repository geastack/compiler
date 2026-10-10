// A database client's log transform takes `LoggableEvent | Record<string,
// any>` -- 26 event types -- and after `switch (logObject.name)` hands the
// value to a helper typed by the one event the case names. The checker
// narrows a union of ten or more object types through its discriminant key
// map, which drops the `Record<string, any>` arm, so the argument is exactly
// one arm of the union. The event classes beside it cannot be viewed as that
// arm, so an unchecked selection would read a class instance's bytes as the
// record; the narrowed argument takes the runtime-checked arm projection.
class ServerClosedEvent {
  name = 'serverClosed' as const
  address = 'localhost:27017'
}
class ServerOpeningEvent {
  name = 'serverOpening' as const
  topologyId = 1
}
type LoggableCommandSucceededEvent = { name: 'commandSucceeded'; duration: number }
type LoggableCommandFailedEvent = { name: 'commandFailed'; failure: string }
type ConnectionCreatedEvent = { name: 'connectionCreated'; connectionId: number }
type ConnectionReadyEvent = { name: 'connectionReady'; connectionId: number; durationMS: number }
type ConnectionClosedEvent = { name: 'connectionClosed'; reason: string }
type PoolCreatedEvent = { name: 'poolCreated'; maxPoolSize: number }
type PoolReadyEvent = { name: 'poolReady'; ready: boolean }
type PoolClearedEvent = { name: 'poolCleared'; interruptInUse: boolean }
type CheckedOutEvent = { name: 'checkedOut'; checkedOut: number }

type LoggableEvent =
  | ServerClosedEvent
  | ServerOpeningEvent
  | LoggableCommandSucceededEvent
  | LoggableCommandFailedEvent
  | ConnectionCreatedEvent
  | ConnectionReadyEvent
  | ConnectionClosedEvent
  | PoolCreatedEvent
  | PoolReadyEvent
  | PoolClearedEvent
  | CheckedOutEvent

function attachCommandFields(event: LoggableCommandSucceededEvent): string {
  return `${event.name}:${event.duration}`
}

function describeServer(event: ServerClosedEvent): string {
  return `closed:${event.address}`
}

function transform(logObject: LoggableEvent | Record<string, any>): string {
  switch (logObject.name) {
    case 'commandSucceeded':
      return attachCommandFields(logObject)
    case 'serverClosed':
      return describeServer(logObject)
    default:
      return 'other'
  }
}

const succeeded: LoggableCommandSucceededEvent = { name: 'commandSucceeded', duration: 12 }
console.log(transform(succeeded), transform(new ServerClosedEvent()), transform(new ServerOpeningEvent()))
//! expect: commandSucceeded:12 closed:localhost:27017 other
