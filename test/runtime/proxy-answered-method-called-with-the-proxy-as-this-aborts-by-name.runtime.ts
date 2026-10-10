//! expect: compressed 3

// The Proxy's get trap answers an async arrow. A member call supplies the
// Proxy as its logical receiver, but the arrow ignores that dynamic `this`.
// Its receiverless native frame must therefore run, just as JavaScript does,
// without projecting the Proxy into the union's ordinary module layout.

type ZStandardLib = {
  compress(buf: Uint8Array, level?: number): Promise<Uint8Array>
}
type ZStandard = ZStandardLib | { kModuleError: Error }

function makeShimModule(impl: any): ZStandard {
  return new Proxy({}, { get: (_: any, key: any) => (key === 'kModuleError' ? undefined : impl) })
}

function getLibrary(real: boolean): ZStandard {
  if (real) return { compress: async (buf: Uint8Array) => buf }
  return makeShimModule(async (buf: Uint8Array, _level?: number): Promise<Uint8Array> => buf)
}

async function main(): Promise<void> {
  const data = new Uint8Array([1, 2, 3])
  const lib = getLibrary(data.length === 0)
  if ('kModuleError' in lib) return
  try {
    console.log('compressed ' + (await lib.compress(data, 3)).length)
  } catch {
    console.log('caught')
  }
}

void main()
