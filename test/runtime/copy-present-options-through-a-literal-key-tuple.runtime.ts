// Copying only the PRESENT options through a `const` tuple of literal keys,
// `if (options[name] != null) result[name] = options[name]`, must leave every
// absent key absent. A database client's `parseConnectOptions` does exactly this over
// `LEGAL_TCP_SOCKET_OPTIONS`; a `lookup` that came out present made node's
// socket connect take the custom-lookup path.
type Lookup = (host: string, cb: (err: Error | null, address: string) => void) => void
interface ConnectOpts {
  autoSelectFamily?: boolean
  family?: number
  hints?: number
  localAddress?: string
  lookup?: Lookup
  keepAliveInitialDelay?: number
  noDelay?: boolean
  host?: string
}
interface Options extends ConnectOpts {
  hostAddress: string
}
const LEGAL = ['autoSelectFamily', 'family', 'hints', 'localAddress', 'lookup', 'keepAliveInitialDelay'] as const

function parse(options: Options): ConnectOpts {
  const result: Partial<ConnectOpts> = {}
  for (const name of LEGAL) {
    if (options[name] != null) {
      ;(result as Record<string, unknown>)[name] = options[name]
    }
  }
  result.keepAliveInitialDelay ??= 120000
  result.noDelay = options.noDelay ?? true
  result.host = options.hostAddress
  return result
}

const a = parse({ hostAddress: 'h', family: 4 })
console.log(Object.keys(a).join(','), a.lookup === undefined, 'lookup' in a)
const b = parse({ hostAddress: 'h', lookup: (host, cb) => cb(null, host), autoSelectFamily: false })
console.log(Object.keys(b).join(','), typeof b.lookup, b.autoSelectFamily)

//! expect: family,keepAliveInitialDelay,noDelay,host true false
//! expect: autoSelectFamily,lookup,keepAliveInitialDelay,noDelay,host function false
