//! expect: srv:db.example.com:27017
//! expect: txt:authSource=admin
//! expect: retried:1

// A database client's connection-string parser, `retryDNSTimeoutFor`: `await
// dns.promises[api](address)` where `api` is `'resolveSrv' | 'resolveTxt'`
// awaits a UNION of two promises whose payloads differ (`SrvRecord[]` and
// `string[][]`). Each arm resolves to its own payload, and the two meet only
// in the result union -- so each must be entered into it, not handed to a
// conditional expression that has no common type for them.

interface SrvRecord {
  priority: number
  weight: number
  port: number
  name: string
}

const resolvers = {
  resolveSrv: async (address: string): Promise<SrvRecord[]> => [{ priority: 0, weight: 0, port: 27017, name: 'db.' + address }],
  resolveTxt: async (address: string): Promise<string[][]> => [['authSource=admin'], [address]]
}

let retried = 0

function retryFor(api: 'resolveSrv'): (a: string) => Promise<SrvRecord[]>
function retryFor(api: 'resolveTxt'): (a: string) => Promise<string[][]>
function retryFor(api: 'resolveSrv' | 'resolveTxt'): (a: string) => Promise<SrvRecord[] | string[][]> {
  return async function retry(address: string) {
    try {
      if (retried === 0) {
        retried++
        throw new Error('timeout')
      }
      return await resolvers[api](address)
    } catch {
      return await resolvers[api](address)
    }
  }
}

const resolveSrv = retryFor('resolveSrv')
const resolveTxt = retryFor('resolveTxt')

async function main(): Promise<void> {
  const srv = await resolveSrv('example.com')
  console.log('srv:' + srv[0]!.name + ':' + srv[0]!.port)
  const txt = await resolveTxt('example.com')
  console.log('txt:' + txt[0]![0])
  console.log('retried:' + retried)
}

main()
