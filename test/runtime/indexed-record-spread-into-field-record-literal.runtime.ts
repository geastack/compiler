// A database client's SCRAM auth `prepare`: `{ ...handshakeDoc, speculativeAuthenticate }`
// spreads an interface with an index signature into a literal whose own type
// names its keys. Declared fields and index entries the literal names both land.
interface Doc {
  [key: string]: any
}
interface Handshake extends Doc {
  hello?: boolean
  client: { name: string }
}
interface AuthRequest {
  hello?: boolean
  client: { name: string }
  mechanism?: string
  speculative: { db: string }
}
const prepare = (handshake: Handshake): AuthRequest => ({ ...handshake, speculative: { db: 'admin' } })
const handshake: Handshake = { client: { name: 'gea' } }
handshake['mechanism'] = 'SCRAM'
const request = prepare(handshake)
console.log(request.hello, request.client.name, request.mechanism, request.speculative.db)
const bare = prepare({ hello: true, client: { name: 'x' } })
console.log(bare.hello, bare.client.name, bare.mechanism)
//! expect: undefined gea SCRAM admin
//! expect: true x undefined
