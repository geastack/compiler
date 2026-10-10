// Spreading a class instance whose optional fields may or may not have been
// assigned: a database client logs `{ databaseName, ...args[0] }` where
// `args[0]` is a `CommandStartedEvent`, whose `serviceId?` is written only
// when the connection has one. Under `useDefineForClassFields: false` an
// unassigned field is not an own property, so `CopyDataProperties` must not
// create the key.
class CommandStartedEvent {
  commandName: string
  requestId: number
  serviceId?: string
  name = 'commandStarted'
  constructor(commandName: string, requestId: number, serviceId?: string) {
    this.commandName = commandName
    this.requestId = requestId
    if (serviceId !== undefined) this.serviceId = serviceId
  }
}
type LoggableCommandStartedEvent = {
  databaseName: string
  commandName: string
  requestId: number
  serviceId?: string
  name: string
}
function log(databaseName: string, event: CommandStartedEvent): string {
  const loggable: LoggableCommandStartedEvent = { databaseName, ...event }
  return `${loggable.databaseName} ${loggable.commandName} ${loggable.requestId} ${loggable.serviceId} ${'serviceId' in loggable} ${loggable.name}`
}
console.log(log('app', new CommandStartedEvent('ping', 1)))
console.log(log('app', new CommandStartedEvent('find', 2, 'svc')))
//! expect: app ping 1 undefined false commandStarted
//! expect: app find 2 svc true commandStarted
