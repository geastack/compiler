// A CALLER'S `Document | Document[]` HANDED TO AN OPEN-DOCUMENT PARAMETER.
//
// A database client's `Collection.updateOne(filter, update: UpdateFilter<TSchema> |
// Document[])` passes `update` on to `new UpdateOneOperation(ns, filter,
// update: Document, options)`, which asks `hasAtomicOperators(update)` -- an
// update pipeline is an array. The constructor's cell must hold the array the
// caller hands over as well as the document: before, only a caller passing a
// bare array contributed an array arm, the union's array member was dropped,
// and the store SELECTED the document arm out of whichever arm was live.
// Each member of the caller's union is a candidate arm now.

interface Doc {
  [key: string]: any
}
function hasAtomic(doc: Doc | Doc[]): boolean {
  if (Array.isArray(doc)) {
    for (const d of doc) if (hasAtomic(d)) return true
    return false
  }
  const keys = Object.keys(doc)
  return keys.length > 0 && keys[0]!.startsWith('$')
}
class UpdateOne {
  atomic: boolean
  constructor(update: Doc) {
    this.atomic = hasAtomic(update)
  }
}
function updateOne(update: { $set?: Doc } | Doc[]): boolean {
  return new UpdateOne(update).atomic
}
const pipeline: Doc[] = [{ $set: { a: 1 } }]
//! expect: true true false
console.log(`${updateOne({ $set: { a: 1 } })} ${updateOne(pipeline)} ${updateOne([{ b: 1 }])}`)
