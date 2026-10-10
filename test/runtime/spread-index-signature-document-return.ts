// Spreading an interface that extends an open `Document` (`[key: string]:
// any`) into a literal with one more member, and returning it as that
// interface -- a database client's SCRAM authenticator building its
// speculative handshake. The spread keeps the index signature, so the literal is the
// same open document shape plus a key.

interface WireDocument {
  [key: string]: any
}

interface HandshakeDocument extends WireDocument {
  isPrimary?: boolean
  hello?: boolean
  client: WireDocument
  compression: string[]
}

async function prepare(handshakeDoc: HandshakeDocument, nonce: string): Promise<HandshakeDocument> {
  const request = {
    ...handshakeDoc,
    earlyAuthenticate: { authStart: 1, nonce }
  }
  return request
}

async function main(): Promise<void> {
  const prepared = await prepare({ hello: true, client: { driver: 'gea' }, compression: ['none'], extra: 7 }, 'abc')
  //! expect: true none abc 7
  console.log(prepared.hello, prepared.compression[0], prepared['earlyAuthenticate'].nonce, prepared['extra'])
  //! expect: hello,client,compression,extra,earlyAuthenticate
  console.log(Object.keys(prepared).join(','))
}
void main()
