// AN OBJECT LITERAL WHOSE ONE COMPUTED KEY IS A CHOICE OF TWO LITERALS.
//
// A database client's monitor `checkServer` builds its heartbeat
// command as `{ [serverApi?.version || helloOk ? 'hello' : LEGACY_HELLO_COMMAND]:
// 1, ...(awaitable ? { maxAwaitTimeMS, topologyVersion } : {}) }` and hands it
// to `connection.command(ns, cmd: Document, ...)`, which serializes it by
// walking its own keys. node prints:
//
//   legacy=ismaster=1
//   hello=hello=1,maxAwaitTimeMS=10
//   helloOk=hello=1
//
// The spread erases the computed key from the checker's type of the literal
// (`getSpreadType` keeps an index signature only when both sides have one).
// `structural-creation-order.ts` restores each name the key can take as an
// optional PHANTOM member at the position the literal creates it, so the
// command name enumerates first -- a server reads it off the FIRST key.

const LEGACY = 'ismaster'

interface Api {
  version: string
}

interface Doc {
  [key: string]: any
}

function serialize(cmd: Doc): string {
  return Object.keys(cmd)
    .map((key) => `${key}=${String(cmd[key])}`)
    .join(',')
}

function heartbeat(api: Api | undefined, helloOk: boolean, awaitable: boolean, maxAwaitTimeMS: number): string {
  const cmd = {
    [api?.version || helloOk ? 'hello' : LEGACY]: 1,
    ...(awaitable ? { maxAwaitTimeMS } : {})
  }
  return serialize(cmd)
}

console.log(`legacy=${heartbeat(undefined, false, false, 5)}`)
console.log(`hello=${heartbeat({ version: '1' }, false, true, 10)}`)
console.log(`helloOk=${heartbeat(undefined, true, false, 5)}`)
//! expect: legacy=ismaster=1
//! expect: hello=hello=1,maxAwaitTimeMS=10
//! expect: helloOk=hello=1
