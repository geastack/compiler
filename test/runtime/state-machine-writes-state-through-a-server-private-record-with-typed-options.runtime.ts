// A database driver's state machine moves any `{ s: { state } }` object
// between states. A server's private record also carries its options, typed
// as an intersection (`Omit<PoolOptions, 'id'> & MonitorOptions`) with an
// overloaded callback member, and an event listener receives the server as
// `any`, which publishes the whole object graph to dynamic writers. Nothing
// writes `options` dynamically, and no Document can be read into that
// callback, so the private record's `options` arm has no load to plan -- it
// must not refuse the program, while `state` stays writable by name.
export {}
interface PoolOptions {
  id: number
  maxPoolSize: number
  lookup?: { (host: string): string; (host: string, all: boolean): string[] }
}
interface MonitorOptions {
  heartbeatFrequencyMS: number
}
type ServerOptions = Omit<PoolOptions, 'id'> & MonitorOptions
interface ServerPrivate {
  description: string
  options: ServerOptions
  state: string
}
interface ObjectWithState {
  s: { state: string }
  emit(event: 'stateChanged', state: string, newState: string): void
}
function makeStateMachine(stateTable: { [key: string]: string[] }): (target: ObjectWithState, newState: string) => void {
  return function stateTransition(target, newState) {
    const legalStates = stateTable[target.s.state]
    if (legalStates && legalStates.indexOf(newState) < 0) throw new Error(`illegal ${target.s.state} => ${newState}`)
    target.emit('stateChanged', target.s.state, newState)
    target.s.state = newState
  }
}
const stateTransition = makeStateMachine({ closed: ['connecting'], connecting: ['connected', 'closed'], connected: ['closed'] })
class Server {
  s: ServerPrivate
  constructor(options: ServerOptions) {
    this.s = { description: 'a:1', options, state: 'closed' }
  }
  emit(event: 'stateChanged', state: string, newState: string): void {
    console.log(`server ${event} ${state} -> ${newState} pool=${this.s.options.maxPoolSize}`)
  }
}
const server = new Server({ maxPoolSize: 10, heartbeatFrequencyMS: 500 })
const listeners: ((server: any) => void)[] = [
  (published) => {
    console.log('published', published.s.state, published.s.options.maxPoolSize)
    published.s.state = 'connecting'
  }
]
stateTransition(server, 'connecting')
for (const listener of listeners) listener(server)
stateTransition(server, 'connected')
console.log(server.s.state, server.s.options.maxPoolSize, server.s.options.heartbeatFrequencyMS)
//! expect: server stateChanged closed -> connecting pool=10
//! expect: published connecting 10
//! expect: server stateChanged connecting -> connected pool=10
//! expect: connected 10 500
