//! expect: auto-connect: connected
//! expect: auto-connect again: connected
//! expect: sync: opened 1
//! expect: closure: set 7
//! expect: no-call: absent
//! expect: no-call after: stays absent
//! expect: stream: 1,2
//! emitted-once: if (!(true)) goto
//! emitted-lacks: unreachableValue
//! emitted-once: requireIterablePresent

// A database client's `autoConnect` (in its operation executor): TypeScript keeps
// the narrowing `client.topology: undefined` across `await client.connect()`,
// so the second `== null` test reads as `undefined`-only. It is not: the
// awaited call wrote the field. A narrowed read of a mutable property -- or of
// a `let` a closure writes -- is only as good as the stretch with no call,
// await or yield between the narrowing and the read.

class Topology {
  constructor(readonly name: string) {}
}

class Client {
  topology: Topology | undefined
  async connect(): Promise<void> {
    await Promise.resolve()
    this.topology = new Topology('connected')
  }
}

class ServiceRuntimeError extends Error {}

async function autoConnect(client: Client): Promise<Topology> {
  if (client.topology == null) {
    await client.connect()
    if (client.topology == null) {
      throw new ServiceRuntimeError('client.connect did not create a topology but also did not throw')
    }
    return client.topology
  }
  return client.topology
}

class Resource {
  handle: number | null = null
  open(): void {
    this.handle = 1
  }
}

function sync(resource: Resource): string {
  if (resource.handle == null) {
    resource.open()
    if (resource.handle == null) return 'sync: never opened'
    return `sync: opened ${resource.handle}`
  }
  return 'sync: already open'
}

function closure(): string {
  let value: number | undefined
  const set = (): void => {
    value = 7
  }
  if (value === undefined) {
    set()
    if (value === undefined) return 'closure: never set'
    return `closure: set ${value}`
  }
  return 'closure: preset'
}

class Holder {
  slot: string | undefined
}

// No call between the narrowing and the read: the fold stays trusted, and it
// is the program's one folded branch (`emitted-once` above).
function noCall(holder: Holder): string {
  if (holder.slot == null) {
    if (holder.slot == null) return 'no-call: absent'
    return `no-call: present ${holder.slot}`
  }
  return 'no-call: preset'
}

// A database client's `Connection.readMany`: `for await` over a field assigned just
// before a call that may reset it walks `AsyncGenerator | null`, and an
// absent source is the language's TypeError, not a static impossibility.
async function* numbers(): AsyncGenerator<number, void, void> {
  yield 1
  yield 2
}

class Stream {
  events: AsyncGenerator<number, void, void> | null = null
  pause(): void {
    if (Math.random() > 2) this.events = null
  }
  async *read(): AsyncGenerator<number, void, void> {
    this.events = numbers()
    this.pause()
    for await (const value of this.events) yield value
  }
}

async function main(): Promise<void> {
  const client = new Client()
  console.log(`auto-connect: ${(await autoConnect(client)).name}`)
  console.log(`auto-connect again: ${(await autoConnect(client)).name}`)
  console.log(sync(new Resource()))
  console.log(closure())
  const holder = new Holder()
  console.log(noCall(holder))
  holder.slot = undefined
  console.log(noCall(holder) === 'no-call: absent' ? 'no-call after: stays absent' : 'no-call after: moved')
  const seen: number[] = []
  for await (const value of new Stream().read()) seen.push(value)
  console.log(`stream: ${seen.join(',')}`)
}

void main()
