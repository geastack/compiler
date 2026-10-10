// AN OPEN-DOCUMENT PARAMETER'S ARRAY ARM STORED INTO A `Document` FIELD.
//
// A binary-document serializer's `makeFrame(sourceObject: Document, ...)`
// answers `{ sourceObject: sourceObject, isArray: true, ... }` under
// `Array.isArray(sourceObject)`. The parameter census carries the cell as the
// arms callers and guards put there: the dictionary, the caller's `number[]`,
// the guard's `any[]`. A `Document` field holds an array arm as that array,
// viewed (`gea::dictionary::aliasOf`), never as a copy of its keys and never
// by reading the array's bytes as a dictionary -- which is what this once
// certified, when the store SELECTED the dictionary arm out of the array.

interface Doc {
  [key: string]: any
}

interface Frame {
  source: Doc
  isArray: boolean
}

function makeFrame(source: Doc): Frame {
  if (Array.isArray(source)) {
    return { source: source, isArray: true }
  }
  return { source, isArray: false }
}

const made: Doc = {}
made['a'] = 1
const list = [1, 2, 3]
const plain = makeFrame(made)
const array = makeFrame(list)

//! expect: false true 0,1,2
console.log(`${plain.isArray} ${array.isArray} ${Object.keys(array.source).join(',')}`)
