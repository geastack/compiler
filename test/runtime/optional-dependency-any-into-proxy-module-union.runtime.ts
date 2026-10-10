//! expect: auth-plugin missing: auth-plugin is not installed
//! expect: auth-plugin loaded: svc@host
//! expect: compressor missing: compressor is not installed
//! expect: compressor loaded: 3 bytes at level 5
//! expect: compressor other: TypeError
//! emitted-has: a dynamic value is none of the union's object arms

// A library's optional-dependency loader: `authPlugin = require('auth-plugin')`
// and `Compressor = require('@scope/compressor')`, where `require` answers
// `any` and the slot is `Module | { kModuleError }` -- carried as the module's
// record, the error record, and `makeErrorModule`'s Proxy. The `any` enters
// the union by a checked conversion: an object is adopted as the record arm
// whose required keys it holds, a box can never hold the native Proxy, and
// anything else is a TypeError. The union itself is never boxed.

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
  initializeClient(service: string): Promise<string>
}
type AuthPlugin = AuthPluginModule | { kModuleError: MissingDependencyError }

type CompressorLib = {
  compress(buf: Uint8Array, level?: number): Promise<string>
  decompress(buf: Uint8Array): Promise<Uint8Array>
}
type Compressor = CompressorLib | { kModuleError: MissingDependencyError }

const installed: Record<string, any> = {
  authPlugin: { initializeClient: async (service: string) => service + '@host' },
  compressor: {
    compress: async (buf: Uint8Array, level?: number) => buf.length + ' bytes at level ' + level,
    decompress: async (buf: Uint8Array) => buf
  },
  other: 42
}

function loadOptional(name: string): any {
  const found = installed[name]
  if (found === undefined) throw new Error('Cannot find module ' + name)
  return found
}

function getAuthPlugin(name: string): AuthPlugin {
  let authPlugin: AuthPlugin
  try {
    authPlugin = loadOptional(name)
  } catch (error) {
    authPlugin = makeErrorModule(new MissingDependencyError('auth-plugin is not installed'))
  }
  return authPlugin
}

function getCompressorLibrary(name: string): CompressorLib | { kModuleError: MissingDependencyError } {
  let Compressor: CompressorLib | { kModuleError: MissingDependencyError }
  try {
    Compressor = loadOptional(name)
  } catch (error) {
    Compressor = makeErrorModule(new MissingDependencyError('compressor is not installed'))
  }
  return Compressor
}

// The same slot filled outside the `try`: a module that is none of the arms
// is a TypeError -- node's from the `in` below, this one's from the checked
// conversion itself -- and the caller catches it either way.
function getCompressorUnguarded(name: string): Compressor {
  let Compressor: Compressor = makeErrorModule(new MissingDependencyError('compressor is not installed'))
  Compressor = loadOptional(name)
  return Compressor
}

async function authPlugin(name: string): Promise<string> {
  const plugin = getAuthPlugin(name)
  if ('kModuleError' in plugin) return 'auth-plugin missing: ' + plugin.kModuleError.message
  return 'auth-plugin loaded: ' + (await plugin.initializeClient('svc'))
}

async function compressor(name: string): Promise<string> {
  const lib: Compressor = getCompressorLibrary(name)
  if ('kModuleError' in lib) return 'compressor missing: ' + lib.kModuleError.message
  return 'compressor loaded: ' + (await lib.compress(new Uint8Array([1, 2, 3]), 5))
}

async function compressorUnguarded(name: string): Promise<string> {
  const lib = getCompressorUnguarded(name)
  if ('kModuleError' in lib) return 'compressor missing: ' + lib.kModuleError.message
  return 'compressor loaded: ' + (await lib.compress(new Uint8Array([1, 2, 3]), 5))
}

async function main(): Promise<void> {
  console.log(await authPlugin('absent-auth-plugin'))
  console.log(await authPlugin('authPlugin'))
  console.log(await compressor('absent-compressor'))
  console.log(await compressor('compressor'))
  try {
    console.log('compressor other: ' + (await compressorUnguarded('other')))
  } catch (error) {
    console.log('compressor other: ' + (error as Error).name)
  }
}

void main()

export {}
