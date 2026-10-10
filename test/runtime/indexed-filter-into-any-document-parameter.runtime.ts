// A database client's `updateOne(filter: Filter<TSchema>, ...)` hands its
// filter -- named query operators plus `[key: string]: any` -- to
// `new UpdateOneOperation(ns, filter: Document, ...)`. A `Document` is an open
// `any` document, so the filter reaches it as every own property it has: the
// operators it set, then the keys only its index holds, and never an operator
// it left out. (A struct-backed record enumerates its declared fields before
// its index entries whatever order they were written in, as `Object.keys` on
// the record itself does; the orders here are ones both agree on.)
interface Filter {
  _id?: string
  $and?: Filter[]
  $comment?: string
  [key: string]: any
}

type WireDocument = { [key: string]: any }

function describe(filter: WireDocument): string {
  return Object.keys(filter)
    .map((key) => `${key}=${Array.isArray(filter[key]) ? `[${filter[key].length}]` : String(filter[key])}`)
    .join(',')
}

function updateOne(filter: Filter): string {
  return describe(filter)
}

const byName: Filter = { $comment: 'c', name: 'n' }
byName.age = 3
console.log(updateOne({}), updateOne({ _id: 'a' }), updateOne(byName), updateOne({ $and: [{ x: 1 }, {}], y: true }))
//! expect:  _id=a $comment=c,name=n,age=3 $and=[2],y=true
