//! expect: auth-plugin missing: auth-plugin is not installed
//! expect: compressor missing: compressor is not installed
//! expect: compressor get threw: compressor is not installed
//! expect: auth-plugin set threw: auth-plugin is not installed

// A library's optional-dependency loader: `makeErrorModule` returns `new Proxy(props, handler)`
// whose trap parameters are annotated `any`, so the checker infers
// `Proxy<any>` and the function returns `any`. Its result then flows into
// several optional-dependency slots of DIFFERENT module types, so no single
// use narrows that `any`: it derives to the box. The proxy is still minted
// natively from its target and handler (no --dynamic-fallback), and each slot
// carries it as a `proxy-object` arm beside its own declared module type.

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

interface AuthPluginModule {
  initializeClient(service: string): string
}
type AuthPlugin = AuthPluginModule | { kModuleError: MissingDependencyError }

interface CompressorLib {
  compress(level: number): number
}
type Compressor = CompressorLib | { kModuleError: MissingDependencyError }

function loadAuthPlugin(): AuthPluginModule {
  throw new Error('Cannot find module auth-plugin')
}
function loadCompressor(): CompressorLib {
  throw new Error('Cannot find module compressor')
}

function getAuthPlugin(): AuthPlugin {
  let authPlugin: AuthPlugin
  try {
    authPlugin = loadAuthPlugin()
  } catch {
    authPlugin = makeErrorModule(new MissingDependencyError('auth-plugin is not installed'))
  }
  return authPlugin
}

function getCompressorLibrary(): Compressor {
  let compressor: Compressor
  try {
    compressor = loadCompressor()
  } catch {
    compressor = makeErrorModule(new MissingDependencyError('compressor is not installed'))
  }
  return compressor
}

const authPlugin = getAuthPlugin()
if ('kModuleError' in authPlugin) console.log('auth-plugin missing: ' + authPlugin.kModuleError.message)
else console.log('auth-plugin loaded: ' + authPlugin.initializeClient('svc'))

const compressor = getCompressorLibrary()
if ('kModuleError' in compressor) {
  console.log('compressor missing: ' + compressor.kModuleError.message)
  try {
    console.log('unexpected ' + (compressor as unknown as CompressorLib).compress(1))
  } catch (error) {
    console.log('compressor get threw: ' + (error as MissingDependencyError).message)
  }
} else console.log('compressor loaded: ' + compressor.compress(1))

try {
  ;(authPlugin as { kModuleError: MissingDependencyError }).kModuleError = new MissingDependencyError('other')
  console.log('unexpected set')
} catch (error) {
  console.log('auth-plugin set threw: ' + (error as MissingDependencyError).message)
}
