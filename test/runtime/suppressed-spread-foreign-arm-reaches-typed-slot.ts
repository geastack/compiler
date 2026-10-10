// A database client's `performInitialHandshake` copies its whole
// ConnectionOptions into a CommandOptions under `@ts-expect-error`:
//
//   // @ts-expect-error: TODO
//   const handshakeOptions: CommandOptions = { ...options, raw: false }
//
// ConnectionOptions carries TLS's `session?: Buffer` and CommandOptions
// declares `session?: ClientSession`, so a Buffer can land in the ClientSession
// slot. Node then reads it as one: on a server that answers `operationTime`,
// `session.supports.causalConsistency` throws a TypeError; on one that does
// not, the Buffer is silently ignored. A checked copy that threw at the
// spread would diverge on the second; the slot has to hold what its writers
// actually store.

class ClientSession {
  supports = { causalConsistency: true }
  operationTime = 0
  advanceOperationTime(time: number): void {
    this.operationTime = time
  }
}

interface TlsOptions {
  session?: Uint8Array
  servername?: string
}

interface ConnectionOptions extends TlsOptions {
  hostAddress: string
}

interface CommandOptions {
  session?: ClientSession
  raw?: boolean
}

interface Reply {
  operationTime?: number
}

function updateSessionFromResponse(session: ClientSession, document: Reply): void {
  if (document.operationTime && session && session.supports.causalConsistency) {
    session.advanceOperationTime(document.operationTime)
  }
}

function implicitSession(): ClientSession {
  return new ClientSession()
}

// The foreign value survives a `??` merge that keeps it: node hands the Buffer
// on, and only a missing one is replaced.
function command(options: CommandOptions, reply: Reply): string {
  const session = options.session ?? implicitSession()
  updateSessionFromResponse(session, reply)
  return options.raw ? 'raw' : 'parsed'
}

// Another slot of the SAME checker type, `ClientSession | undefined`, that no
// suppressed write reaches: its `??=` merge keeps a bare ClientSession carrier.
class Operation {
  session: ClientSession | undefined = undefined
}
function execute(operation: Operation, reply: Reply): number {
  let session = operation.session
  if (session == null) session = implicitSession()
  operation.session ??= session
  updateSessionFromResponse(operation.session, reply)
  return operation.session.operationTime
}

function handshake(options: ConnectionOptions, reply: Reply): string {
  // @ts-expect-error: the connection options are not command options
  const handshakeOptions: CommandOptions = { ...options, raw: false }
  try {
    return command(handshakeOptions, reply)
  } catch (error) {
    return error instanceof TypeError ? 'TypeError' : 'other'
  }
}

//! expect: no-session=parsed
console.log('no-session=' + handshake({ hostAddress: 'a' }, { operationTime: 5 }))
//! expect: buffer-standalone=parsed
console.log('buffer-standalone=' + handshake({ hostAddress: 'a', session: new Uint8Array(2) }, {}))
//! expect: buffer-replica=TypeError
console.log('buffer-replica=' + handshake({ hostAddress: 'a', session: new Uint8Array(2) }, { operationTime: 5 }))

const real = new ClientSession()
//! expect: real-session=parsed 7
console.log('real-session=' + command({ session: real }, { operationTime: 7 }) + ' ' + real.operationTime)

//! expect: operation=9
console.log('operation=' + execute(new Operation(), { operationTime: 9 }))
