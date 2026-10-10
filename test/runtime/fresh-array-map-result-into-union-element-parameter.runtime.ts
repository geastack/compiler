// The array `Array.prototype.map` just allocated, handed straight to a
// parameter whose element is a UNION the mapped record is one arm of
// (a database client's `insertMany`: `this.bulkWrite(docs.map(doc => ({ insertOne:
// { document: doc } })))` into `ReadonlyArray<AnyBulkWriteOperation>`). No
// other reference holds the fresh array, so it is rebuilt once at the
// parameter's element carrier.
//! emitted-has: appendRangeConverted

interface Doc {
  [key: string]: any
}

type Operation = { insertOne: { document: Doc } } | { deleteOne: { filter: Doc } } | { updateOne: { filter: Doc; update: Doc } }

function bulkWrite(operations: ReadonlyArray<Operation>): string {
  return operations
    .map((operation) => {
      if ('insertOne' in operation) return `insert(${Object.keys(operation.insertOne.document).join('|')})`
      if ('deleteOne' in operation) return `delete(${Object.keys(operation.deleteOne.filter).join('|')})`
      return `update(${Object.keys(operation.updateOne.update).join('|')})`
    })
    .join(',')
}

function insertMany(docs: ReadonlyArray<Doc>): string {
  return bulkWrite(docs.map((doc) => ({ insertOne: { document: doc } })))
}

//! expect: insert(a|b),insert(c)
console.log(insertMany([{ a: 1, b: 2 }, { c: 3 }]))
//! expect: delete(x)
console.log(bulkWrite([{ deleteOne: { filter: { x: 1 } } }]))
