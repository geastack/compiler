// `Set<Doc>.has(value)` for a value held as `any` is an identity
// question: a binary-document serializer asks `path.has(value)` of every nested value. A
// member is a native record / class instance / array registered under its own
// identity; a non-member must answer false without minting a view, and an
// object whose membership ended must answer false again.
//! expect: true false true false false false false
//! expect: false true
//! emitted-has: gea::dictionary::setHasObject(

type Doc = { [key: string]: any }

class Item {
  n = 1
}

const path = new Set<Doc>()
function visit(value: any): boolean {
  return path.has(value)
}

const record = { a: 1 }
const node = new Item()
const items = [1, 2]
path.add(record)
path.add(node as any)
console.log(visit(record), visit({ a: 1 }), visit(node), visit(new Item()), visit(items), visit(5), visit(null))
path.delete(record)
path.add(items as any)
console.log(visit(record), visit(items))
