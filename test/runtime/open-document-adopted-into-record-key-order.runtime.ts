// An open document (a parser's `any` result, read where a typed record is
// declared) is ADOPTED: its keys the record does not declare move into the
// record's sidecar and the record enumerates them in the document's own
// order. A document whose declared fields come first, in declared order --
// every wire-format document with `_id` first -- needs no order log; one whose order
// departs from that takes the document's.

interface WireDocument {
  [key: string]: any
}
interface Doc extends WireDocument {
  _id: number
  name?: string
}

function open(text: string): any {
  return JSON.parse(text)
}
function keysOf(doc: Doc): string {
  return Object.keys(doc).join(',')
}

const natural = open('{"_id":1,"a":10,"b":20}') as Doc
//! expect: natural=_id,a,b 1 10 20
console.log(`natural=${keysOf(natural)} ${natural._id} ${natural['a']} ${natural.b}`)

const extraFirst = open('{"a":10,"_id":2,"b":20}') as Doc
//! expect: extraFirst=a,_id,b
console.log(`extraFirst=${keysOf(extraFirst)}`)

const interleaved = open('{"b":20,"_id":3,"name":"n","a":10}') as Doc
//! expect: interleaved=b,_id,name,a n
console.log(`interleaved=${keysOf(interleaved)} ${interleaved.name}`)

const declaredSwapped = open('{"name":"n","_id":4,"a":10}') as Doc
//! expect: declaredSwapped=name,_id,a
console.log(`declaredSwapped=${keysOf(declaredSwapped)}`)

// A declared field created after adoption enumerates last, after the adopted keys.
const later = open('{"_id":5,"a":10}') as Doc
later.name = 'late'
//! expect: later=_id,a,name
console.log(`later=${keysOf(later)}`)

// A key added through the index signature after adoption enumerates last too.
const appended = open('{"_id":6,"a":10}') as Doc
appended['z'] = 1
appended.name = 'n'
//! expect: appended=_id,a,z,name
console.log(`appended=${keysOf(appended)}`)

// The document and the record stay one object.
const shared = open('{"_id":7,"a":10}')
const typed = shared as Doc
typed['b'] = 30
//! expect: shared=_id,a,b 30 true
console.log(`shared=${Object.keys(shared).join(',')} ${shared['b']} ${JSON.stringify(shared) === JSON.stringify(typed)}`)
