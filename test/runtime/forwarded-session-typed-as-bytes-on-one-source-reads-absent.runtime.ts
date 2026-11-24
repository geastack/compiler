// Two option records reach one database-options view that declares no
// `session`: a client's, whose `session` is a TLS session held as bytes (and
// absent here), and an operation's, whose `session` is a client session
// object. The read-preference helper reads `session` through that view as a
// client session. On the bytes-typed route no value can ever be a client
// session, so the read there is legal only while the key is absent -- which
// it is -- and the operation's route reads its session as usual.

export {}
class ClientSession {
  transaction = { options: { readPreference: 'from-transaction' } }
}
interface ReadPreferenceOptions {
  readPreference?: string
  session?: ClientSession
}
interface ClientOptions {
  session?: Uint8Array
  readPreference?: string
  appName: string
}
interface OperationOptions {
  readPreference?: string
  session?: ClientSession
  raw?: boolean
}
interface DbOptions {
  readPreference?: string
  raw?: boolean
}
function readPreferenceOf(options?: ReadPreferenceOptions): string | undefined {
  if (!options) return undefined
  return options.readPreference ?? options.session?.transaction.options.readPreference
}
function viaDb(options: DbOptions): string | undefined {
  return readPreferenceOf(options)
}
const client: ClientOptions = { appName: 'app' }
const operation: OperationOptions = { session: new ClientSession(), raw: true }
const explicit: ClientOptions = { readPreference: 'nearest', appName: 'other' }
console.log(viaDb(client))
console.log(viaDb(operation))
console.log(viaDb(explicit))
//! expect: undefined
//! expect: from-transaction
//! expect: nearest
