//! expect: guarded: auth-plugin is not installed
//! expect: unguarded: auth-plugin is not installed
//! expect: loaded: svc@host

// A database client's authentication mechanism: `const { initializeClient } = plugin`, where
// `plugin` is the client's `AuthPlugin` -- a module type or `{ kModuleError }` -- and
// holds either the loaded module or `makeErrorModule`'s Proxy. The pattern's
// own `[[Get]]` reads the union, so the proxy arm runs its `get` trap (which
// throws the stored error, as node does) and every other arm reads its field.

class MissingDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingDependencyError'
  }
}

function makeErrorModule(error: any) {
  const props = error ? { kModuleError: error } : {}
  return new Proxy(props, {
    get: (_: any, key: any) => {
      if (key === 'kModuleError') {
        return error
      }
      throw error
    },
    set: () => {
      throw error
    }
  })
}

interface AuthPluginClient {
  step(challenge: string): Promise<string>
}
// The auth plugin implements it as `promisifiedInitializeClient.call(
// this, ...)`, so its `this` is `any` and the convention states a receiver; the
// destructured bare call passes `undefined` there, as the language does.
interface AuthPluginModule {
  initializeClient(this: any, service: string, options?: { user?: string }): Promise<AuthPluginClient>
}
type AuthPlugin = AuthPluginModule | { kModuleError: MissingDependencyError }

const installed: AuthPluginModule = {
  initializeClient: async function (this: any, service: string) {
    const bound = this === undefined ? '' : '?'
    return { step: async (challenge: string) => service + bound + challenge }
  }
}

function getAuthPlugin(present: boolean): AuthPlugin {
  let authPlugin: AuthPlugin
  try {
    if (!present) throw new Error('Cannot find module auth-plugin')
    authPlugin = installed
  } catch {
    authPlugin = makeErrorModule(new MissingDependencyError('auth-plugin is not installed'))
  }
  return authPlugin
}

let plugin: AuthPlugin

async function makeAuthPluginClient(): Promise<AuthPluginClient> {
  if ('kModuleError' in plugin) {
    throw plugin['kModuleError']
  }
  const { initializeClient } = plugin
  return await initializeClient('svc', {})
}

async function unguarded(): Promise<AuthPluginClient> {
  const { initializeClient } = plugin as AuthPluginModule
  return await initializeClient('svc')
}

async function main(): Promise<void> {
  plugin = getAuthPlugin(false)
  try {
    await makeAuthPluginClient()
    console.log('guarded: unexpected')
  } catch (error) {
    console.log('guarded: ' + (error as MissingDependencyError).message)
  }
  try {
    await unguarded()
    console.log('unguarded: unexpected')
  } catch (error) {
    console.log('unguarded: ' + (error as MissingDependencyError).message)
  }
  plugin = getAuthPlugin(true)
  const client = await makeAuthPluginClient()
  console.log('loaded: ' + (await client.step('@host')))
}

void main()
