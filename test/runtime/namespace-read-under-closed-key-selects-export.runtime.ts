//! expect: enc(cbc:a) dec(ctr:b)
//! expect: srv:x txt:y mx:z
//! expect: txt:again

// `crypto[method](...)` (an encryption plugin's crypto callbacks) and
// `dns.promises[api](...)` (a database client's connection-string parser): a module
// namespace indexed by a key the checker closed to a union of string
// literals. Each literal names an export, so the read selects that export's
// binding by the run-time key -- the namespace object is never materialized.
import * as ciphers from './_namespace-keyed-members'

function hook(method: 'createCipheriv' | 'createDecipheriv', mode: 'cbc' | 'ctr') {
  return (input: string): string => ciphers[method](mode).update(input)
}

function retry(api: 'resolveSrv' | 'resolveTxt' | 'resolveMx') {
  return async (name: string): Promise<string> => {
    const first = await ciphers.lookups[api](name)
    return first.join(',')
  }
}

console.log(hook('createCipheriv', 'cbc')('a') + ' ' + hook('createDecipheriv', 'ctr')('b'))

async function main(): Promise<void> {
  const answers = await Promise.all([retry('resolveSrv')('x'), retry('resolveTxt')('y'), retry('resolveMx')('z')])
  console.log(answers.join(' '))
  const api: 'resolveSrv' | 'resolveTxt' = answers.length > 2 ? 'resolveTxt' : 'resolveSrv'
  const read = ciphers.lookups[api]
  console.log((await read('again')).join(','))
}
main()
