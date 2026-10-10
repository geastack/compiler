//! expect: missing: sdk is not installed
//! expect: loads: 1
//! expect: get threw: sdk is not installed

// A database client's cloud-credentials provider: a static field typed by a loader's
// return type is filled lazily by `??=`, and the loader's failure path returns
// `makeErrorModule`'s `new Proxy`. A proxy therefore really does flow into the
// static field, so the field, the `??=` merge and every later read of it must
// carry the proxy arm consistently -- dropping it would lose the handler.

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

interface CredentialProvider {
  fromNodeProviderChain(label: string): string
}

function loadSdk(): CredentialProvider {
  throw new Error('Cannot find module sdk')
}

let loads = 0

function getProvider(): CredentialProvider | { kModuleError: MissingDependencyError } {
  loads++
  try {
    return loadSdk()
  } catch {
    return makeErrorModule(new MissingDependencyError('sdk is not installed'))
  }
}

class SdkCredentials {
  private static _sdk: ReturnType<typeof getProvider>

  static get sdk() {
    SdkCredentials._sdk ??= getProvider()
    return SdkCredentials._sdk
  }

  chain(): string {
    const sdk = SdkCredentials.sdk
    if ('kModuleError' in sdk) throw sdk.kModuleError
    return sdk.fromNodeProviderChain('default')
  }
}

try {
  new SdkCredentials().chain()
} catch (error) {
  console.log(`missing: ${(error as Error).message}`)
}
SdkCredentials.sdk
SdkCredentials.sdk
console.log(`loads: ${loads}`)
try {
  const sdk = SdkCredentials.sdk as CredentialProvider
  sdk.fromNodeProviderChain('x')
} catch (error) {
  console.log(`get threw: ${(error as Error).message}`)
}
