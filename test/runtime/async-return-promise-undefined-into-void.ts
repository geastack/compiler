//! expect: wrote:a
//! expect: done
//! expect: wrote:b
//! expect: done
// `@hono/node-server` listener.ts: `responseViaCache` is declared
// `Promise<undefined | void>` and both its callers `return` its promise from
// an async function whose own inferred result is `Promise<void>`. The two
// payloads are the same run-time value -- ECMAScript fulfils a `void` promise
// with `undefined` -- so the reconciliation is state adoption with the payload
// elided, not a hole.
const writeOne = async (name: string): Promise<undefined | void> => {
  if (name === '') {
    return
  }
  console.log(`wrote:${name}`)
}

const viaCache = async (name: string): Promise<void> => {
  return writeOne(name)
}

const viaInferred = async (name: string) => {
  if (name === 'skip') {
    return
  }
  return writeOne(name)
}

const main = async (): Promise<void> => {
  await viaCache('a')
  console.log('done')
  await viaInferred('b')
  console.log('done')
}

await main()
