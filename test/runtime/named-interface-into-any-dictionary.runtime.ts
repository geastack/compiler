// A database client builds typed command documents (`OIDCCommand`,
// `ClientBulkWriteCommand`) and hands them to `connection.command(ns, cmd)`,
// whose parameter is `Document` -- `{ [key: string]: any }`. The named
// interface's fields are poured into the open dictionary; an optional field
// the literal never wrote is no own property and must not appear as a key.
interface WireDocument {
  [key: string]: any
}

interface OIDCCommand {
  saslStart?: number
  saslContinue?: number
  mechanism?: string
  payload: string
}

function start(user: string): OIDCCommand {
  return { saslStart: 1, mechanism: 'SERVICE-OIDC', payload: user }
}

function command(cmd: WireDocument): string {
  return Object.keys(cmd)
    .map((key) => `${key}=${cmd[key]}`)
    .join(',')
}

console.log(command(start('alice')))
const next: OIDCCommand = { saslContinue: 2, payload: 'token' }
console.log(command(next))
//! expect: saslStart=1,mechanism=SERVICE-OIDC,payload=alice
//! expect: saslContinue=2,payload=token
