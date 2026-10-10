// A `{ [index: number]: any }` TABLE WRITTEN AND READ WITH A KEY TYPED `any`.
//
// A database client's `BulkWriteResult.generateIdMap`:
// `idMap[doc.index] = doc._id` where `doc` is a `Document`. The key reaches
// the table through ToPropertyKey, the same canonical string a literal
// numeric key names.

interface IdDocument {
  [key: string]: any
}

const generateIdMap = (ids: IdDocument[]): { [key: number]: any } => {
  const idMap: { [index: number]: any } = {}
  for (const doc of ids) {
    idMap[doc.index] = doc._id
  }
  return idMap
}

const map = generateIdMap([
  { index: 0, _id: 'a' },
  { index: 2, _id: 'b' }
])
const probe: any = 2
//! expect: 0=a 2=b probe=b keys=0,2
console.log(`0=${map[0]} 2=${map[2]} probe=${map[probe]} keys=${Object.keys(map).join(',')}`)
