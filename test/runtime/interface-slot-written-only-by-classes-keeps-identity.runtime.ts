// An interface no class declares it implements, whose slots the program only
// ever fills with class instances, holds those instances -- not a rebuilt
// copy of the interface's fields. A database client's `stateTransition(target:
// ObjectWithState, newState)` writes `target.s.state`; with the target rebuilt
// per call the write landed in the copy and the topology stayed `closed`.
interface ObjectWithState {
  s: { state: string }
  emit(event: 'stateChanged', state: string, newState: string): void
}
function makeStateMachine(table: Record<string, string[]>): (target: ObjectWithState, next: string) => void {
  return function stateTransition(target, next) {
    const legal = table[target.s.state]
    if (legal && legal.indexOf(next) < 0) throw new Error(`illegal ${target.s.state} => ${next}`)
    target.emit('stateChanged', target.s.state, next)
    target.s.state = next
  }
}
const transition = makeStateMachine({ closed: ['connecting'], connecting: ['connected', 'closed'], connected: ['closed'] })
class Topology {
  s: { state: string; servers: number }
  log: string[] = []
  constructor() {
    this.s = { state: 'closed', servers: 0 }
  }
  emit(event: 'stateChanged', state: string, next: string): void {
    this.log.push(`${event}:${state}->${next}`)
  }
  connect(): void {
    transition(this, 'connecting')
    transition(this, 'connected')
  }
}
class Pool {
  s: { state: string }
  changes = 0
  constructor() {
    this.s = { state: 'closed' }
  }
  emit(): void {
    this.changes++
  }
  open(): void {
    transition(this, 'connecting')
  }
}
const topology = new Topology()
topology.connect()
const pool = new Pool()
pool.open()
console.log(topology.s.state, topology.log.join(' '), pool.s.state, pool.changes)
try {
  transition(pool, 'connected')
  transition(pool, 'connecting')
} catch (error) {
  console.log((error as Error).message)
}

//! expect: connected stateChanged:closed->connecting stateChanged:connecting->connected connecting 1
//! expect: illegal connected => connecting
