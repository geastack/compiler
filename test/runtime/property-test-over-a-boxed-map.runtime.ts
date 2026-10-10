// `in` AND A PROPERTY READ ON A MAP HELD AS A PLAIN DOCUMENT.
//
// A binary-document serializer asks `'_wiretype' in value` of every value it
// walks and then reads `value._wiretype`, and a database client hands it a
// `Map` document (the client metadata). The Map crossed into the dynamic
// document as a box, whose property test refused outright ("no per-struct
// field dispatcher"), so the driver aborted before its handshake. A Map has no own
// properties but its expandos; its chain is `Map.prototype` then `Object.prototype`.

type WireDocument = Record<string, any>

function probe(value: unknown): string {
  const doc = value as WireDocument
  return `${'_wiretype' in doc} ${String(doc._wiretype)} ${'get' in doc} ${'toString' in doc}`
}

// The serializer's `isAnyArrayBuffer`, asked of the same Map.
function tagOf(value: unknown): string {
  if (typeof value === 'object' && value != null && Symbol.toStringTag in value) return String((value as any)[Symbol.toStringTag])
  return 'none'
}

const map = new Map<string, number>([['a', 1]])
//! expect: map false undefined true true
console.log(`map ${probe(map)}`)
//! expect: tag Map none
const walked: unknown[] = []
walked.push(map)
walked.push('text')
console.log(`tag ${tagOf(walked[0])} ${tagOf(walked[1])}`)
//! expect: size 1
console.log(`size ${map.size}`)
