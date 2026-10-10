// AN OPEN-DOCUMENT PARAMETER HANDED ON, WHOLE, TO ANOTHER ONE.
//
// A database client and its serializer pass `Document`s from function to function; the first
// function's parameter census learns the arms its callers and guards put in
// the cell (here the caller's `number[]` and the guard's `any[]` beside the
// dictionary). `keysOf(d: Doc)` is called only with `source`, so its own
// cell holds whatever `source` holds. It used to hold the dictionary arm
// alone, and the call SELECTED that arm out of `source` unchecked: the array
// `[7, 8]` was read as a dictionary and `Object.keys` answered nothing. The
// arms now forward along the call, and the array keeps its identity and keys.
//
// A whole union still entering one of its arms' slots unnarrowed is the
// checked exact-arm projection (a TypeError on another arm), never the
// unchecked selection.

interface Doc {
  [key: string]: any
}

function keysOf(d: Doc): string {
  return Object.keys(d).join(',')
}

function describe(source: Doc): string {
  const kind = Array.isArray(source) ? 'array' : 'object'
  return `${kind}:${keysOf(source)}`
}

const made: Doc = {}
made['a'] = 1
made['b'] = 2

//! expect: object:a,b array:0,1
console.log(`${describe(made)} ${describe([7, 8])}`)
