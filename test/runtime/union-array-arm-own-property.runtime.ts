// An ordinary own property read off the ARRAY arm of a union -- a binary-document
// serializer's `internalCalculateObjectSize` reads `(obj as any)?.toWire` off a `Document`
// that may view an array. `toWire` is no Array.prototype name, so an array
// answers it from its own properties (the shared expando table), which hold
// none here: `undefined`.
type Doc = unknown[] | { toWire?: () => string; v: number }

function describe(obj: Doc): string {
  const isArray = Array.isArray(obj)
  if (typeof (obj as any)?.toWire === 'function') return `custom:${(obj as any).toWire()}`
  return isArray ? 'array' : 'plain'
}
const plainArray: unknown[] = []
plainArray.push('x')
console.log(describe(plainArray), describe({ v: 1 }), describe({ v: 2, toWire: () => 'from-record' }))
//! expect: array plain custom:from-record
