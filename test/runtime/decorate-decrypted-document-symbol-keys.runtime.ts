// A DOCUMENT DECORATED WITH A NON-ENUMERABLE SYMBOL-KEYED ARRAY, RECURSIVELY.
//
// A database client's `decorateDecryptionResult(decrypted: Document & { [kDecoratedKeys]?:
// Array<string> }, original: Document, isTopLevelDecorateCall = true)`
// walks `Object.keys(decrypted)`. Where the ORIGINAL held an
// encrypted Binary (`_wiretype === 'Binary'`, `sub_type === 6`) it defines a
// non-enumerable `kDecoratedKeys` array on `decrypted` (once) and pushes the
// key; otherwise it recurses into `decrypted[k]` with the original's value.
// A `Buffer` original is deserialized first; a non-object `decrypted` stops.

const kDecoratedKeys = Symbol.for('@@client.decryptedKeys')

interface Doc {
  [key: string]: any
}

function decorate(decrypted: Doc & { [kDecoratedKeys]?: Array<string> }, original: Doc, isTopLevel = true): void {
  if (isTopLevel && original instanceof Uint8Array) {
    original = { fromBytes: original.length }
  }
  if (!decrypted || typeof decrypted !== 'object') return
  for (const k of Object.keys(decrypted)) {
    const originalValue = original[k]
    if (originalValue && originalValue._wiretype === 'Binary' && originalValue.sub_type === 6) {
      if (!decrypted[kDecoratedKeys]) {
        Object.defineProperty(decrypted, kDecoratedKeys, {
          value: [],
          configurable: true,
          enumerable: false,
          writable: false
        })
      }
      decrypted[kDecoratedKeys]!.push(k)
      continue
    }
    decorate(decrypted[k], originalValue, false)
  }
}

const decrypted: Doc = { ssn: '123', nested: { card: '4111', plain: 1 }, n: 2 }
const original: Doc = {
  ssn: { _wiretype: 'Binary', sub_type: 6 },
  nested: { card: { _wiretype: 'Binary', sub_type: 6 }, plain: 1 },
  n: 2
}
decorate(decrypted, original)
//! expect: top=ssn nested=card enumerable=ssn,nested,n
console.log(
  `top=${(decrypted[kDecoratedKeys as any] as string[]).join(',')} nested=${(decrypted.nested[kDecoratedKeys] as string[]).join(',')} enumerable=${Object.keys(decrypted).join(',')}`
)
