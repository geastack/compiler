// A pool's merged options handed on as the narrower connection options are a
// live view of the pool's object. Constructing the connection through an
// `any` constructor (`options.connectionType ?? Connection`) boxes that view
// as its ORIGINAL object, so the constructor's frame receives the pool's
// layout and must read it back through the same view, not refuse it as the
// wrong payload.

export {}
interface ConnectionOptions {
  id: number
  host: string
  noDelay?: boolean
  connectionType?: any
}
interface PoolOptions extends ConnectionOptions {
  maxPoolSize: number
  appName: string
}
class Connection {
  id: number
  address: string
  constructor(socket: string, options: ConnectionOptions) {
    this.id = options.id
    this.address = `${socket}@${options.host}${options.noDelay === true ? '+nodelay' : ''}`
    options.id += 100
  }
}
class TracedConnection extends Connection {}
function makeConnection(options: ConnectionOptions, socket: string): Connection {
  const ConnectionType = options.connectionType ?? Connection
  return new ConnectionType(socket, options)
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
const suffix = String(Math.random()).slice(0, 0)
const pool: PoolOptions = { id: 1, host: 'h', maxPoolSize: 5, appName: 'a' }
install(pool, `noDelay${suffix}`, true)
const plain = makeConnection(pool, 's')
console.log(plain.id, plain.address, pool.id, plain instanceof TracedConnection)
const traced = makeConnection({ ...pool, connectionType: TracedConnection }, 't')
console.log(traced.id, traced.address, traced instanceof TracedConnection)
//! expect: 1 s@h+nodelay 101 false
//! expect: 101 t@h+nodelay true
