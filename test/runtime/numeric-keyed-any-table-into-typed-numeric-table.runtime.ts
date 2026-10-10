// A `{ [key: number]: any }` table returned where `{ [key: number]: Id }` is
// declared (a database client's `insertMany`: the bulk result's id map becomes
// `InsertManyResult.insertedIds`, typed by the collection's id). Every entry
// is checked into the declared carrier, keys kept in their order.

class Id {
  constructor(readonly hex: string) {}
}

interface BulkResult {
  insertedIds: { [key: number]: any }
}

interface InsertManyResult {
  insertedCount: number
  insertedIds: { [key: number]: Id }
}

function bulkWrite(hexes: string[]): BulkResult {
  const map: { [index: number]: any } = {}
  hexes.forEach((hex, index) => {
    map[index] = new Id(hex)
  })
  return { insertedIds: map }
}

function insertMany(hexes: string[]): InsertManyResult {
  const res = bulkWrite(hexes)
  return { insertedCount: hexes.length, insertedIds: res.insertedIds }
}

const result = insertMany(['aa', 'bb', 'cc'])
//! expect: 3 aa,bb,cc keys=0,1,2
console.log(
  `${result.insertedCount} ${[result.insertedIds[0]!.hex, result.insertedIds[1]!.hex, result.insertedIds[2]!.hex].join(',')} keys=${Object.keys(result.insertedIds).join(',')}`
)
