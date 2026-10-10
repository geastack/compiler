//! expect: compress: missing compressor
//! expect: decompress: missing compressor
//! expect: loads 1
//! expect: loaded: z(abc) u(xyz)
//! expect: loads 2

// A database client's compression module, reduced to its shape: `let compressor: Compressor` has
// no initializer, a helper fills it lazily, and each async caller narrows the
// union with `'kModuleError' in compressor` before calling through the library arm.
// The read carries `undefined` (the cell is unwritten until the loader runs),
// so the narrowing selects an arm out of `optional(tagged-union)`, and the
// union keeps the Proxy arm `makeErrorModule` puts there.

class MissingDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingDependencyError'
  }
}

type CompressorLib = {
  compress(buf: string, level?: number): Promise<string>
  decompress(buf: string): Promise<string>
}

type Compressor = CompressorLib | { kModuleError: MissingDependencyError }

let installed = false
let loads = 0

// The client's `makeErrorModule`: the missing module is a Proxy whose every
// read but `kModuleError` throws, so the union also carries a proxy arm.
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

function getCompressorLibrary(): CompressorLib | { kModuleError: MissingDependencyError } {
  loads++
  let library: CompressorLib | { kModuleError: MissingDependencyError }
  if (!installed) library = makeErrorModule(new MissingDependencyError('missing compressor'))
  else library = { kModuleError: new MissingDependencyError('unused') }
  if (!installed) return library
  return {
    compress: async (buf: string, level?: number) => `z(${buf})${level === undefined ? '' : ''}`,
    decompress: async (buf: string) => `u(${buf})`
  }
}

let compressor: Compressor

function loadCompressor(): void {
  if (!compressor) {
    compressor = getCompressorLibrary()
  }
}

async function compress(data: string): Promise<string> {
  loadCompressor()
  if ('kModuleError' in compressor) {
    throw compressor['kModuleError']
  }
  return await compressor.compress(data, 3)
}

async function decompress(data: string): Promise<string> {
  loadCompressor()
  if ('kModuleError' in compressor) {
    throw compressor.kModuleError
  }
  return await compressor.decompress(data)
}

const failure = (error: unknown): string => (error instanceof MissingDependencyError ? error.message : 'unexpected')

async function main(): Promise<void> {
  console.log(`compress: ${await compress('abc').catch(failure)}`)
  console.log(`decompress: ${await decompress('abc').catch(failure)}`)
  console.log(`loads ${loads}`)
  installed = true
  compressor = getCompressorLibrary()
  console.log(`loaded: ${await compress('abc')} ${await decompress('xyz')}`)
  console.log(`loads ${loads}`)
}

void main()
