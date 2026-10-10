// An object-literal computed key typed as a union of literals is checked only
// against the index signature, never against the member the key lands on, so
// the value may lie outside that member's declared type (a database client's handshake
// document: `{ [api ? 'hello' : 'ismaster']: 1 }` into `hello?: boolean`).
interface Doc {
  [key: string]: any
}
interface Handshake extends Doc {
  ismaster?: boolean
  hello?: boolean
  helloOk?: boolean
  client: Doc
}
const LEGACY = 'ismaster'
function make(api: string | undefined): Handshake {
  const doc: Handshake = {
    [api ? 'hello' : LEGACY]: 1,
    helloOk: true,
    client: { name: 'x' }
  }
  return doc
}
const a = make('1')
const b = make(undefined)
console.log('a', a.hello, typeof a.hello, a.ismaster === undefined, a.helloOk, a.client.name)
console.log('b', b.ismaster, typeof b.ismaster, b.hello === undefined, Object.keys(b).join(','))
console.log('json', JSON.stringify(a), JSON.stringify(b))

//! expect: a 1 number true true x
//! expect: b 1 number true ismaster,helloOk,client
//! expect: json {"hello":1,"helloOk":true,"client":{"name":"x"}} {"ismaster":1,"helloOk":true,"client":{"name":"x"}}
