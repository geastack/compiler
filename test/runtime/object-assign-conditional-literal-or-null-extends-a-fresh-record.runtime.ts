// A binary-document serializer writes a reference value as an ordered
// document: `Object.assign({ $ref, $id }, ref.db != null ? { $db: ref.db } :
// null, ref.fields)`. The middle source is a fresh literal OR null -- a null
// source copies nothing -- and the literal names a typed key (`$db`) the
// target literal does not declare, so the copy extends the fresh target with
// a typed field. The result is then walked as a plain `Document`.
interface Doc {
  [key: string]: any
}
class ObjectId {
  constructor(readonly id: number) {}
}
class DBRef {
  collection: string
  oid: ObjectId
  db?: string
  fields: Doc
  constructor(collection: string, oid: ObjectId, db?: string, fields?: Doc) {
    this.collection = collection
    this.oid = oid
    this.db = db
    this.fields = fields || {}
  }
}
function describe(value: unknown): string {
  if (value instanceof ObjectId) return `ObjectId(${value.id})`
  return String(value)
}
function ordered(dbref: DBRef): Doc {
  const orderedValues: Doc = Object.assign(
    { $ref: dbref.collection, $id: dbref.oid },
    dbref.db != null ? { $db: dbref.db } : null,
    dbref.fields
  )
  return orderedValues
}
function walk(document: Doc): string {
  const keys = Object.keys(document)
  return keys.map((key) => `${key}=${describe(document[key])}`).join(',')
}
console.log(walk(ordered(new DBRef('todos', new ObjectId(7), 'app', JSON.parse('{"x":1}')))))
console.log(walk(ordered(new DBRef('users', new ObjectId(3)))))
console.log(walk(ordered(new DBRef('items', new ObjectId(5), undefined, { tag: 'a', n: 2 }))))

//! expect: $ref=todos,$id=ObjectId(7),$db=app,x=1
//! expect: $ref=users,$id=ObjectId(3)
//! expect: $ref=items,$id=ObjectId(5),tag=a,n=2
