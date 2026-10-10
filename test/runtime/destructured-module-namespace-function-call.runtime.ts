// A function destructured out of a module namespace TYPE and called bare --
// a database client's `const { initializeClient } = plugin; await initializeClient(spn,
// initOptions)` in its authentication mechanism, where `plugin` is `typeof
// import('auth-plugin') | { kModuleError }` narrowed by `'kModuleError' in plugin`.
// `auth-plugin` is types-only in the native build, so the module arm is never
// the live one; the call must still compile, and a module's exported function
// has no receiver, so the bare call supplies none. (The client's own `plugin` also
// carries the `makeErrorModule` Proxy arm, whose `in`/destructuring loads are
// a separate open row.)
//! expect: missing
type AuthPlugin = typeof import('./_destructured-ambient-module') | { kModuleError: Error }

let plugin: AuthPlugin | undefined

function loadAuthPlugin(): AuthPlugin {
  if (!plugin) plugin = { kModuleError: new Error('missing') }
  return plugin
}

async function makeClient(): Promise<string> {
  const loaded = loadAuthPlugin()
  if ('kModuleError' in loaded) {
    throw loaded['kModuleError']
  }
  const { initializeClient } = loaded
  const initOptions = {}
  Object.assign(initOptions, { user: 'alice' })
  const client = await initializeClient('svc@host', initOptions)
  return client.name
}

async function main(): Promise<void> {
  try {
    console.log(await makeClient())
  } catch (error) {
    // node prints: missing
    console.log((error as Error).message)
  }
}
void main()
