// `Array.isArray` guarding a value that is already statically an array: the
// a database client's `Collection.bulkWrite(operations: ReadonlyArray<...>)`
// opens with `if (!Array.isArray(operations)) throw ...`. TypeScript narrows
// the parameter to `readonly Op[] & any[]`, whose elements read as `any` -- but
// the value is the same typed array, and its elements are still `Op`s. The
// guard narrows nothing physical, so the binding keeps the array's own carrier.
type Op = { insertOne: { n: number } } | { deleteOne: { tag: string } }

function total(operations: ReadonlyArray<Op>): number {
  if (!Array.isArray(operations)) throw new TypeError('operations must be an array')
  let sum = 0
  for (const operation of operations) sum += 'insertOne' in operation ? operation.insertOne.n : operation.deleteOne.tag.length
  return sum + operations.length
}

console.log(total([{ insertOne: { n: 3 } }, { deleteOne: { tag: 'ab' } }]))
//! expect: 7
