// A Node HTTP adapter's websocket upgrade hands its own bindings
// record to a callback typed for two OTHER records, through `unknown`:
//
//   const env: UpgradeBindings = { incoming: request, outgoing: undefined, wss, [WAIT_SYMBOL]: waitForWebSocket }
//   await fetchCallback(createUpgradeRequest(request), env as unknown as Parameters<FetchCallback>[1])
//
// The assertion emits nothing: the callee receives `env` itself, so the
// record keeps its own arm of the parameter's union rather than being copied
// into one of the declared records.
interface HttpBindings {
  incoming: string
  outgoing: number
}

interface Http2Bindings {
  incoming: string
  outgoing: boolean
}

interface UpgradeBindings {
  incoming: string
  outgoing: undefined
  wss: string
}

type FetchCallback = (request: string, env: HttpBindings | Http2Bindings) => string

const handler: FetchCallback = (request, env) => request + ':' + env.incoming

const plain = handler('plain', { incoming: 'h1', outgoing: 1 })

const env: UpgradeBindings = { incoming: 'socket', outgoing: undefined, wss: 'server' }
const upgraded = handler('upgrade', env as unknown as Parameters<FetchCallback>[1])

//! expect: plain:h1 upgrade:socket server
console.log(plain + ' ' + upgraded + ' ' + env.wss)
