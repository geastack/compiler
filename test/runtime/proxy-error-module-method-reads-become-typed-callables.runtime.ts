//! expect: compressor compress: compressor is not installed
//! expect: compressor decompress: compressor is not installed
//! expect: cloud instance: cloud-metadata is not installed
//! expect: cloud absent: cloud-metadata is not installed

// A library's optional-dependency error module read the way its compression
// and cloud-credential providers read it: a METHOD off the module, called with
// typed arguments (`compressor.compress(buffer, level)`,
// `cloudMetadata.instance<T>({...})`).
// The Proxy `get` trap answers `any` -- the missing-dependency error, or it
// throws -- so the method the site calls is recovered from that box by the
// checked dynamic-callable bridge, which verifies it is a Function and adapts
// its frame; here the trap throws first, exactly as node does.

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
      if (key === 'kModuleError') return error
      throw error
    },
    set: () => {
      throw error
    }
  })
}

type CompressorLib = {
  compress(buf: Uint8Array, level?: number): Promise<Uint8Array>
  decompress(buf: Uint8Array): Promise<Uint8Array>
}
type Compressor = CompressorLib | { kModuleError: MissingDependencyError }

type CloudMetadata = { instance<T>(options?: string | { property: string }): Promise<T> } | { kModuleError: MissingDependencyError }

function loadModule(name: string): never {
  throw new Error('Cannot find module ' + name)
}

function getCompressorLibrary(): Compressor {
  let compressor: Compressor
  try {
    compressor = loadModule('@scope/compressor')
  } catch {
    compressor = makeErrorModule(new MissingDependencyError('compressor is not installed'))
  }
  return compressor
}

function getCloudMetadata(): CloudMetadata {
  try {
    return loadModule('cloud-metadata')
  } catch {
    return makeErrorModule(new MissingDependencyError('cloud-metadata is not installed'))
  }
}

let compressorModule: Compressor | undefined

function loadCompressor(): Compressor {
  compressorModule ??= getCompressorLibrary()
  return compressorModule
}

async function compress(data: Uint8Array): Promise<Uint8Array> {
  const compressor = loadCompressor()
  if ('kModuleError' in compressor) throw compressor['kModuleError']
  return await compressor.compress(data, 3)
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const compressor = loadCompressor()
  if ('kModuleError' in compressor) throw compressor['kModuleError']
  return await compressor.decompress(data)
}

async function loadCloudCredentials(): Promise<string> {
  const cloudMetadata = getCloudMetadata()
  if ('kModuleError' in cloudMetadata) return 'cloud absent: ' + cloudMetadata.kModuleError.message
  const { access_token: accessToken } = await cloudMetadata.instance<{ access_token: string }>({
    property: 'service-accounts/default/token'
  })
  return accessToken
}

// The error module answers `in` through its target, which does hold
// `kModuleError`; a module that did not would reach the method read, and the
// trap throws there. Read once more without the guard to take that path.
async function loadCloudUnguarded(): Promise<string> {
  const cloudMetadata = getCloudMetadata()
  if ('instance' in cloudMetadata) {
    const { access_token: accessToken } = await cloudMetadata.instance<{ access_token: string }>({ property: 'token' })
    return accessToken
  }
  return (cloudMetadata.kModuleError as MissingDependencyError).message
}

async function main(): Promise<void> {
  const data = new Uint8Array([1, 2, 3])
  try {
    console.log('unexpected ' + (await compress(data)).length)
  } catch (error) {
    console.log('compressor compress: ' + (error as MissingDependencyError).message)
  }
  try {
    console.log('unexpected ' + (await decompress(data)).length)
  } catch (error) {
    console.log('compressor decompress: ' + (error as MissingDependencyError).message)
  }
  console.log('cloud instance: ' + (await loadCloudUnguarded()))
  console.log(await loadCloudCredentials())
}

void main()
