// A literal-keyed read of a dynamic receiver remembers the types it found the
// key absent on (a binary-document serializer's `value.toWire` probe). The memory is per type, so an
// instance that later gains the key as an expando must still answer it, a
// and a string's miss is the key's alone.
//! expect: undefined undefined
//! expect: added undefined
//! expect: undefined undefined
//! emitted-has: gea::literalPropertyGet<

interface Rec {
  a: number
}

function probe(value: any): unknown {
  return value.extra
}

const first: Rec = { a: 1 }
const second: Rec = { a: 2 }
console.log(String(probe(first)), String(probe(first)))
;(second as any).extra = 'added'
console.log(String(probe(second)), String(probe(first)))
console.log(String(probe('text')), String(probe('text')))
