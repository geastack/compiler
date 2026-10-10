// A record-carried field narrowed to a byte array by a guard no record can
// pass -- a database client's `AutoEncrypter`:
// `!Buffer.isBuffer(this._kmsProviders) ? serialize(this._kmsProviders) : this._kmsProviders`
// with `_kmsProviders: KMSProviders`. A plain data record is never a
// `Uint8Array`, so the guard answers false and the narrowed read is dead.

interface KmsProviders {
  local?: { key: string }
  aws?: { accessKeyId: string }
}

function serialize(value: KmsProviders): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function isBytes(value: KmsProviders | Uint8Array): value is Uint8Array {
  return value instanceof Uint8Array
}

class Encrypter {
  _kmsProviders: KmsProviders
  constructor(providers: KmsProviders | undefined) {
    this._kmsProviders = providers || {}
  }
  options(): Uint8Array {
    return !isBytes(this._kmsProviders) ? serialize(this._kmsProviders) : this._kmsProviders
  }
}

const bytes = new Encrypter({ local: { key: 'k' } }).options()
//! expect: 21 {"local":{"key":"k"}}
console.log(bytes.length, new TextDecoder().decode(bytes))
//! expect: 2
console.log(new Encrypter(undefined).options().length)
