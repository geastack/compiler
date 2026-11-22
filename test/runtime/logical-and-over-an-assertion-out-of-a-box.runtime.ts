// `api && api.version` where `api` is a named-record reference built either as
// a fresh literal or by asserting an `unknown` value to the interface. A shared
// record reference reserves an undefined lane for strict unbound receivers, so
// the `&&` keeps `api` on a falsy edge the merge (`string`) cannot hold; only
// this body's own definitions of `api` show the edge is dead -- the literal
// is an object, and the assertion out of the box refuses anything that is not.
// A driver's `serverApi` option transform is the shape.

export {}

interface ServerApi {
  version: string
  strict?: boolean
}

function transform(values: unknown[]): string {
  const version = values[0]
  const api = typeof version === 'string' ? ({ version } as ServerApi) : (version as ServerApi)
  const v = api && api.version
  if (!v) throw new Error('bad')
  return v
}

const inputs: unknown[] = JSON.parse('[[{"version":"1"}],["2"],[{"version":""}]]')
for (const input of inputs) {
  try {
    console.log(`ok:${transform(input as unknown[])}`)
  } catch (error) {
    console.log(`threw:${String(error).split(':')[0]}`)
  }
}
//! expect: ok:1
//! expect: ok:2
//! expect: threw:Error
