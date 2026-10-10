// A database client's `deleteOne(filter: Filter<TSchema> = {})` defaults a
// query document -- an open record of optional operators plus an index
// signature -- to the empty literal. The empty literal IS such a document with
// nothing present: no declared operator and no indexed key.
interface Filter {
  _id?: string
  $and?: Filter[]
  $comment?: string
  [key: string]: unknown
}

function describe(filter: Filter = {}): string {
  const keys = Object.keys(filter)
  return `${keys.length}:${filter._id ?? '-'}:${filter.$and?.length ?? '-'}:${keys.join(',')}`
}

console.log(describe(), describe({ _id: 'a' }), describe({ $and: [{}, { x: 1 }], name: 'n' }))
//! expect: 0:-:-: 1:a:-:_id 2:-:2:$and,name
