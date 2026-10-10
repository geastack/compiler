// A constructor carried by its construct ABI alone -- a record field typed
// with a construct signature -- still is a function object with properties:
// its class's statics (an encryption plugin's
// `mc.Cipher.cipherLibraryVersion`), its real prototype object (a binary-document serializer's
// `Buffer.prototype?._isBuffer`), and `undefined` for a key nothing
// declares.

// The slot's `new` answers `unknown`, so the class's instance crosses into it
// boxed -- a genuine dynamic boundary. A slot answering a structural interface
// would need the class instance viewed as that record, which is not installed
// and refuses at certification rather than slicing the instance into a copy.
interface CipherConstructor {
  new (options: { tag: string }): unknown
  cipherLibraryVersion: string
  missing?: string
}

class NativeCipher {
  static cipherLibraryVersion = '1.8.4'
  tag: string
  constructor(options: { tag: string }) {
    this.tag = options.tag
  }
  describe(): string {
    return `crypt:${this.tag}`
  }
}

const bindings: { Cipher: CipherConstructor } = { Cipher: NativeCipher }

class Cipher {
  static readonly cipherLibraryVersion: string = bindings.Cipher.cipherLibraryVersion
}

console.log(Cipher.cipherLibraryVersion, typeof new bindings.Cipher({ tag: 'x' }), bindings.Cipher.missing === undefined)

interface BufferLike {
  new (options: { tag: string }): unknown
  prototype?: { describe?: unknown; _isBuffer?: boolean }
}

const holder: { Buffer: BufferLike } = { Buffer: NativeCipher }
const proto = holder.Buffer.prototype
console.log(typeof proto, typeof proto?.describe, proto?._isBuffer !== true)

//! expect: 1.8.4 object true
//! expect: object function true
