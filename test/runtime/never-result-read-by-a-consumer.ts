//! expect: load failed: unavailable ./b.node
//! expect: read failed: not implemented: readFile
//! expect: tls failed: not implemented: readFile
// A `never`-typed call result READ by a consumer other than `return`: an
// initializer, an `await` operand, a store. The point after the call is
// unreachable, so the read needs a value that is never observed, not a
// refusal. node-compat rewrites `require('<x>.node')` into a `never` call
// (an encryption plugin's native bindings, `export const mc = load()`),
// and its unimplemented `fs/promises.readFile` is `never` too (a database
// client's cloud-credential workflow and its TLS-option setup).
function unavailable(specifier: string): never {
  throw new Error('unavailable ' + specifier)
}
function readFile(..._args: unknown[]): never {
  throw new Error('not implemented: readFile')
}
interface Bindings {
  version: string
}
function load() {
  try {
    return unavailable('./a.node')
  } catch {
    try {
      return unavailable('./b.node')
    } catch (error) {
      throw error
    }
  }
}
function init(): Bindings {
  const bindings: Bindings = load()
  return bindings
}
const callback = async (): Promise<{ accessToken: string }> => {
  const token = await readFile('/token', 'utf8')
  return { accessToken: token }
}
interface TlsOptions {
  cert?: Buffer | string
}
async function setTlsOptions(options: TlsOptions): Promise<void> {
  options.cert = await readFile('/cert')
}
try {
  console.log('loaded ' + init().version)
} catch (error) {
  console.log('load failed: ' + (error instanceof Error ? error.message : 'other'))
}
// This backend's `await` does not suspend (`ir/model.ts`'s `AwaitOperation`),
// so a throw before any real suspension leaves an async body synchronously
// rather than as a rejection. Both routes land in the same reporter, so the
// test pins the never-read lowering and not that separate gap.
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'other')
const tls = (): void => {
  const options: TlsOptions = {}
  const failed = (error: unknown): void => console.log('tls failed: ' + messageOf(error))
  try {
    setTlsOptions(options).then(() => console.log('tls ok'), failed)
  } catch (error) {
    failed(error)
  }
}
const readFailed = (error: unknown): void => {
  console.log('read failed: ' + messageOf(error))
  tls()
}
try {
  callback().then((value) => console.log('read ' + value.accessToken), readFailed)
} catch (error) {
  readFailed(error)
}
