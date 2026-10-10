// A database client's `AutoEncrypter` takes `schemaMap?: Document` and serializes it
// unless `Buffer.isBuffer(options.schemaMap)` says it already is wire-format bytes.
// A Document can be a Buffer only if it views one, so the narrowed arm reads
// the object the Document views and refuses anything else; a Document that
// holds its own entries never passes the guard and takes the other arm.
interface WireDocument {
  [key: string]: any
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

function encode(document: WireDocument): Uint8Array {
  return new Uint8Array(Object.keys(document).length)
}

function schemaBytes(schemaMap?: WireDocument): Uint8Array {
  return isBytes(schemaMap) ? schemaMap : encode(schemaMap ?? {})
}

console.log(schemaBytes({ a: 1, b: 2 }).length, schemaBytes().length)
// A Document that views bytes passes the guard and is those bytes.
const bytes = new Uint8Array(3)
bytes[0] = 7
const raw: any = bytes
console.log(schemaBytes(raw).length, schemaBytes(raw)[0])
//! expect: 2 0
//! expect: 3 7
//! emitted-has: gea::dictionary::viewedObjectAs<
//! emitted-has: gea::dictionary::viewedObjectIs<
// The narrowed arm and the guard both ask the Document's viewed object
// natively (`viewedObjectAs` / `viewedObjectIs`); the `aliasedObject` this
// asserted before materialized that object as a `gea::Value` first.
