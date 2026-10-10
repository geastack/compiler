// Copying a fixed list of named options out of a typed options record by a
// computed key -- a database client's `parseSslOptions`:
// `for (const name of LEGAL_TLS_SOCKET_OPTIONS) if (options[name] != null) (result as Document)[name] = options[name]`.
// The key is a union of the record's own member names, so the read answers
// the union of those members' types.
//
// Each key names a DECLARED member, so the read is sealed at lowering
// (`typed-property-access.ts`'s `declaredMemberReadRecipeOf`) as one arm per
// key: the member's own storage and presence bit, converted by its own census
// node into the union -- the constant-key read of that member, never a box.
// The dynamic route it replaces boxed each member and had no decoder back
// into the union's callable arm (`checkServerIdentity`). `sink` exposes the
// options record to an `any` boundary, as a database client's options are,
// so the receiver's reflection demand is `full` and the recipe must survive it.
//! expect: db 2 undefined 1024 7 ctx
//! expect: undefined mismatch other
//! emitted-has: if (__gea_key == "checkServerIdentity") { if (__gea_receiver->gea_present_checkServerIdentity)

interface WireDocument {
  [key: string]: any
}

class SecureContext {
  name: string
  constructor(name: string) {
    this.name = name
  }
}

interface TlsOptions {
  ca?: string | Uint8Array | Array<string | Uint8Array>
  checkServerIdentity?: (host: string, cert: object) => Error | undefined
  secureContext?: SecureContext
  rejectUnauthorized?: boolean
  minDHSize?: number
  session?: Uint8Array
}

interface ConnectionOptions extends TlsOptions {
  host: string
}

const LEGAL_TLS_SOCKET_OPTIONS = ['ca', 'checkServerIdentity', 'rejectUnauthorized', 'minDHSize', 'secureContext', 'session'] as const

function sink(value: any): void {
  if (value === 42) console.log(value)
}

function parseSslOptions(options: ConnectionOptions & { existingSocket?: object }): TlsOptions & { host?: string } {
  sink(options)
  const result: TlsOptions & { host?: string } = { host: options.host }
  for (const name of LEGAL_TLS_SOCKET_OPTIONS) {
    if (options[name] != null) {
      ;(result as WireDocument)[name] = options[name]
    }
  }
  return result
}

const parsed = parseSslOptions({
  host: 'db',
  ca: ['a', 'b'],
  checkServerIdentity: (host) => (host === 'db' ? undefined : new Error('mismatch ' + host)),
  minDHSize: 1024,
  secureContext: new SecureContext('ctx'),
  session: new Uint8Array([7])
})
// node prints: db 2 undefined 1024 7 ctx
console.log(
  parsed.host,
  Array.isArray(parsed.ca) ? parsed.ca.length : 0,
  parsed.rejectUnauthorized,
  parsed.minDHSize,
  parsed.session?.[0],
  parsed.secureContext?.name
)
// node prints: undefined mismatch other
console.log(parsed.checkServerIdentity?.('db', {}), parsed.checkServerIdentity?.('other', {})?.message)
