// Optional fields of many types copied by a loop over a constant key tuple.
// `options[name] != null` narrows the keyed read itself (the key is a const
// loop variable), so the value written is the union of the fields' present
// types, never `undefined`.

export {}

class SecureContext {
  constructor(readonly label: string) {}
}

interface TlsOptions {
  allowPartialTrustChain?: boolean
  ALPNProtocols?: string[] | Uint8Array[] | Uint8Array
  ca?: string | Uint8Array | Array<string | Uint8Array>
  checkServerIdentity?: (host: string, port: number) => Error | undefined
  minDHSize?: number
  secureContext?: SecureContext
  servername?: string
}

class Logger {
  lines: string[] = []
}

interface ConnectOptions extends TlsOptions {
  host: string
  port: number
  logger?: Logger
  ready?: Promise<number>
  extra?: { readonly note: string }
}

class Socket {
  constructor(readonly fd: number) {}
}

type MakeConnectionOptions = ConnectOptions & { existingSocket?: Socket }

const LEGAL_TLS_SOCKET_OPTIONS = [
  'allowPartialTrustChain',
  'ALPNProtocols',
  'ca',
  'checkServerIdentity',
  'minDHSize',
  'secureContext',
  'servername'
] as const

type Document = Record<string, any>

function parseSslOptions(options: MakeConnectionOptions): Document {
  const result: Document = { host: options.host, port: options.port }
  for (const name of LEGAL_TLS_SOCKET_OPTIONS) {
    if (options[name] != null) {
      ;(result as Document)[name] = options[name]
    }
  }
  if (options.existingSocket) {
    result.socket = options.existingSocket.fd
  }
  return result
}

const describe = (value: unknown): string =>
  value instanceof SecureContext
    ? `ctx:${value.label}`
    : value instanceof Uint8Array
      ? `bytes:${value.length}`
      : typeof value === 'function'
        ? 'fn'
        : Array.isArray(value)
          ? `[${value.length}]`
          : String(value)

const show = (document: Document): string =>
  Object.keys(document)
    .map((key) => `${key}=${describe(document[key])}`)
    .join(' ')

console.log(show(parseSslOptions({ host: 'h', port: 1 })))
console.log(
  show(
    parseSslOptions({
      host: 'db',
      port: 27017,
      allowPartialTrustChain: false,
      ALPNProtocols: new Uint8Array(3),
      ca: ['a', 'b'],
      checkServerIdentity: () => undefined,
      minDHSize: 1024,
      secureContext: new SecureContext('tls'),
      servername: 'sni',
      logger: new Logger(),
      ready: Promise.resolve(1),
      extra: { note: 'x' },
      existingSocket: new Socket(9)
    })
  )
)

const wide = { host: 'w', port: 2, servername: 's', minDHSize: 7, retries: 3, logger: new Logger(), tag: new SecureContext('t') }
console.log(show(parseSslOptions(wide)))

//! expect: host=h port=1
//! expect: host=db port=27017 allowPartialTrustChain=false ALPNProtocols=bytes:3 ca=[2] checkServerIdentity=fn minDHSize=1024 secureContext=ctx:tls servername=sni socket=9
//! expect: host=w port=2 minDHSize=7 servername=s
