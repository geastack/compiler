// A connect-options builder copies the keys an options bag sets, one by one,
// into a fresh partial record through a `Document` view, returns it as one of
// two socket option types, and a TLS builder then views the same record as an
// unrelated TLS options type, copies its own keys -- a string, a string and a
// boolean -- into it through the same `Document` view and reads them back at
// the TLS type. Each copied key's value is the source's value for that very
// key, so each lands in its own slot of that one record with its own type.

export {}
type Document = Record<string, any>
interface SocketOpts {
  keepAlive?: boolean
  keepAliveInitialDelay?: number
}
interface TcpOpts extends SocketOpts {
  host?: string
  port: number
  family?: number
  localAddress?: string
}
interface IpcOpts extends SocketOpts {
  path: string
}
interface TlsOpts {
  host?: string
  port?: number
  path?: string
  ca?: string
  servername?: string
  rejectUnauthorized?: boolean
}
interface ConnectionOptions {
  host: string
  port: number
  family?: number
  localAddress?: string
  ca?: string
  servername?: string
  rejectUnauthorized?: boolean
}
type TlsOwnOpts = Pick<TlsOpts, 'ca' | 'servername' | 'rejectUnauthorized'>
const TCP_KEYS = ['family', 'localAddress'] as const
const TLS_KEYS = ['ca', 'servername', 'rejectUnauthorized'] as const

function parseConnectOptions(options: ConnectionOptions): TcpOpts | IpcOpts {
  const result: Partial<TcpOpts & IpcOpts & TlsOwnOpts> = {}
  for (const name of TCP_KEYS) {
    if (options[name] != null) {
      ;(result as Document)[name] = options[name]
    }
  }
  result.keepAliveInitialDelay ??= 120
  result.keepAlive = true
  if (options.host.startsWith('/')) {
    result.path = options.host
    return result as IpcOpts
  }
  result.host = options.host
  result.port = options.port
  return result as TcpOpts
}
function parseSslOptions(options: ConnectionOptions): TlsOpts {
  const result: TlsOpts = parseConnectOptions(options)
  for (const name of TLS_KEYS) {
    if (options[name] != null) {
      ;(result as Document)[name] = options[name]
    }
  }
  if (result.servername == null && result.host) result.servername = result.host
  return result
}
const tls = parseSslOptions({ host: 'db.example', port: 27017, family: 4, ca: 'pem', rejectUnauthorized: false })
const tcp = tls as TcpOpts
console.log(
  tls.host,
  tls.port,
  tcp.family,
  tcp.localAddress,
  tls.ca,
  tls.servername,
  tls.rejectUnauthorized,
  tcp.keepAlive,
  tcp.keepAliveInitialDelay
)
const plain = parseSslOptions({ host: 'h', port: 1, servername: 'named' })
console.log(plain.servername, (plain as TcpOpts).family, plain.ca)
const ipc = parseSslOptions({ host: '/run/db.sock', port: 0 })
console.log(ipc.path, ipc.host, ipc.servername)
//! expect: db.example 27017 4 undefined pem db.example false true 120
//! expect: named undefined undefined
//! expect: /run/db.sock undefined undefined
