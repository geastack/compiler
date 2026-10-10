// AN ARROW'S LEXICAL `this` PASSED AS AN ARGUMENT IS STILL THE RECEIVER AFTER.
//
// a database client's `ConnectionPool` constructor schedules
// `process.nextTick(() => this.emitAndLog(CREATED, new ConnectionPoolCreatedEvent(this)))`.
// The arrow's body evaluates the receiver `this`, then the argument `this`,
// and calls. The native body moved `this` into the event's constructor as a
// dying argument -- the argument read was the one read of it the move census
// counted -- and then called `emitAndLog` on the emptied handle, which
// crashed dereferencing null.

class PoolEvent {
  constructor(readonly source: Pool) {}
}

class Pool {
  events: string[] = []
  constructor(readonly name: string) {}
  schedule(): () => void {
    return () => this.record(new PoolEvent(this))
  }
  record(event: PoolEvent): void {
    this.events.push(`${event.source.name}->${this.name}`)
  }
}

const pool = new Pool('p')
const tick = pool.schedule()
tick()
tick()
//! expect: p->p,p->p
console.log(pool.events.join(','))
