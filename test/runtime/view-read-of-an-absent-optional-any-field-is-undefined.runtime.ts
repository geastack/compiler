// A connect-options literal read through the narrower socket-options view: an
// optional `unknown` field carries no `Optional` wrapper, so the view's route
// must still consult the source's presence -- a literal that never named
// `signal` reads `undefined` there instead of refusing the read.

export {}
interface SocketOptions {
  fd?: number
  allowHalfOpen?: boolean
  onread?: unknown
  readable?: boolean
  signal?: unknown
  noDelay?: boolean
  blockList?: unknown
}
interface TcpConnect {
  host?: string
  port: number
  family?: number
}
interface PathConnect {
  path: string
}
interface TcpOptions extends TcpConnect, SocketOptions {
  timeout?: number
}
interface PathOptions extends PathConnect, SocketOptions {
  timeout?: number
}
type ConnectOptions = TcpOptions | PathOptions
class Socket {
  half: boolean
  noDelay: boolean
  where = ''
  constructor(options: SocketOptions = {}) {
    this.noDelay = options.noDelay ?? false
    this.half = options.allowHalfOpen === true
    if (options.fd !== undefined) throw new Error('fd')
    if (options.onread !== undefined) throw new Error('onread')
    if (options.signal !== undefined) throw new Error('signal')
    if (options.blockList !== undefined) throw new Error('blockList')
    if (options.readable === false) throw new Error('readable')
  }
  connect(options: TcpConnect | PathConnect): this {
    this.where = 'path' in options ? options.path : `${options.host ?? 'localhost'}:${options.port}`
    return this
  }
}
function createConnection(options: ConnectOptions | number): Socket {
  if (typeof options === 'object') {
    const socket = new Socket(options)
    const connected = socket.connect(options)
    if (options.timeout !== undefined) connected.where += `/${options.timeout}`
    return connected
  }
  return new Socket().connect({ port: options })
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
const suffix = String(Math.random()).slice(0, 0)
const options: TcpOptions = { host: '127.0.0.1', port: 27017, timeout: 5 }
install(options, `noDelay${suffix}`, true)
const socket = createConnection(options)
console.log(socket.where, socket.noDelay, socket.half)
console.log(createConnection({ path: '/s', allowHalfOpen: true }).half, createConnection(1).where)
console.log(new Socket({ allowHalfOpen: true, readable: true }).half)
//! expect: 127.0.0.1:27017/5 true false
//! expect: true localhost:1
//! expect: true
