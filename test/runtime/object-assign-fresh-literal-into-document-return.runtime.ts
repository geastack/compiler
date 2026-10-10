// A binary-document library's reference type `toJSON`: `Object.assign({ $ref, $id }, this.fields)` returns
// `DBRefLike & Document`, then a named optional key is added after the
// spread-in fields. The assigned object keeps its own insertion order --
// `$ref,$id,<fields...>,$db` -- because it is one object, not a copy.
interface Doc {
  [key: string]: any
}
interface DBRefLike {
  $ref: string
  $id: number
  $db?: string
}
class DBRef {
  collection: string
  oid: number
  db?: string
  fields: Doc
  constructor(collection: string, oid: number, db?: string, fields?: Doc) {
    this.collection = collection
    this.oid = oid
    if (db !== undefined) this.db = db
    this.fields = fields || {}
  }
  toJSON(): DBRefLike & Doc {
    const o = Object.assign(
      {
        $ref: this.collection,
        $id: this.oid
      },
      this.fields
    )
    if (this.db != null) o.$db = this.db
    return o
  }
}
const withDb = new DBRef('todos', 7, 'app', JSON.parse('{"x":1}')).toJSON()
console.log(Object.keys(withDb).join(','), withDb.$ref, withDb.$id, withDb.$db, withDb.x)
const bare = new DBRef('users', 3).toJSON()
console.log(Object.keys(bare).join(','), bare.$db === undefined)
console.log(JSON.stringify(withDb))

//! expect: $ref,$id,x,$db todos 7 app 1
//! expect: $ref,$id true
//! expect: {"$ref":"todos","$id":7,"x":1,"$db":"app"}
