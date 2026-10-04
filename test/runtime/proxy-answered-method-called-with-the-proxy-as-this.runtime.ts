//! expect: compressed 3

// A Proxy whose `get` trap really answers a function: the language calls it
// with the proxy itself as `this`. What a trap answers is `dynamic`
// (`semantics/proxy-origins.ts`), so the call goes through the box, and the
// proxy enters the receiver slot as its own box (`gea::boxProxyObject`). It
// is never a load of the union's other arm.

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
