// A database client's optional-peer probe (the cloud-metadata loader its
// dependency module and its encryption credential provider share), in a
// program that also uses a binary-document serializer's typed-array brand
// check and the driver's `this.commandObj = {}; this.commandObj[name] = true`
// (its command-monitoring events).
//
// The peer is absent (in the driver its `require` throws MODULE_NOT_FOUND;
// this harness has no CommonJS loader, so the probe goes straight to its
// `catch` arm) and the probe returns a stub. The driver's stub is a Proxy
// (absent-optional-peer-proxy-keeps-intrinsics-intact.runtime.ts); this one
// is the plain `{ kModuleError }` record, so it runs without
// --dynamic-fallback. The call typed by the peer's own declarations,
// `peer.instance({ ... })`, is made on a program object -- never on host
// code -- so it cannot touch `Object` or `Object.prototype`, and the
// brand check's reflective chain over `Object.getOwnPropertyDescriptor` /
// `Object.getPrototypeOf` stays intact. An error class with a `name` getter
// elsewhere does not make the event class's own `name` field an accessor.
declare module 'geatsc-absent-optional-peer' {
  export function instance(options: { property: string }): Promise<{ token: string }>
}

type Peer = typeof import('geatsc-absent-optional-peer') | { kModuleError: Error }

class MissingDependencyError extends Error {
  override get name(): string {
    return 'MissingDependencyError'
  }
}

function makeErrorModule(error: Error) {
  return { kModuleError: error }
}

function loadPeer(): Peer {
  return makeErrorModule(new MissingDependencyError('optional peer not found'))
}

async function loadToken(): Promise<string> {
  const peer = loadPeer()
  if ('kModuleError' in peer) return 'missing:' + peer.kModuleError.message
  const { token } = await peer.instance({ property: 'service-accounts/default/token' })
  return token
}

class StartedEvent {
  commandObj?: Record<string, unknown>
  name = 'started'
  constructor(commandName: string) {
    this.commandObj = {}
    this.commandObj[commandName] = true
  }
}

const TypedArrayPrototypeGetSymbolToStringTag = (() => {
  const g = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
  return (value: unknown) => g.call(value)
})()

function isUint8Array(value: unknown): value is Uint8Array {
  return TypedArrayPrototypeGetSymbolToStringTag(value) === 'Uint8Array'
}

const started = new StartedEvent('hello')
//! expect: started {"hello":true}
console.log(started.name + ' ' + JSON.stringify(started.commandObj))
//! expect: true false false
console.log(isUint8Array(new Uint8Array(2)) + ' ' + isUint8Array(new Int8Array(2)) + ' ' + isUint8Array([1]))
loadToken().then((token) => {
  //! expect: missing:optional peer not found
  console.log(token)
})
