// Two recursive wrappers that name each other: an Array of optional values
// that may be the other wrapper, and a dictionary whose values may be the
// Array (a JSON-like value tree, as a database client's option documents
// declare). Each wrapper derives from its runtime container in place, so ADL
// finds the ARRAY's cycle-tracing friend for the array's own element type
// too, and its `requires TraceEdges<Element>::supported` constraint depended
// on itself -- clang refused the whole translation unit.
type Leaf = string | number | boolean
type Tree = { [key: string]: Leaf | Tree | Branch }
type Branch = (Leaf | Tree | Branch | undefined)[]

const branch: Branch = ['a', 1, undefined]
const tree: Tree = { name: 'root', items: branch }
const nested: Tree = { child: tree, flag: true }
branch.push(nested)

const count = (value: Leaf | Tree | Branch | undefined): number => {
  if (value === undefined) return 0
  if (Array.isArray(value)) {
    let total = 1
    for (const item of value) if (item !== nested) total += count(item)
    return total
  }
  if (typeof value === 'object') {
    let total = 1
    for (const key of Object.keys(value)) total += count(value[key])
    return total
  }
  return 1
}

console.log(String(count(tree)))
console.log(String(branch.length))

//! expect: 5
//! expect: 4
