//! expect: keys 2 _id,$comment
//! expect: viewed 2
//! expect: where $where,_id
//! expect: where $where
//! emitted-lacks: gea_record_type_

// A database client's `Filter<TSchema>` is `{ [key: string]: any }` plus optional named
// operators, one of which is `$where?: string | ((this: T) => boolean)`. A
// member that MAY be a function does not need a call convention until a program
// narrows it, so it is an `any` slot's value like every other key and the
// whole type is the open document -- not a record that every `Document` the
// driver forwards it as has to view. The literal is built as the document
// directly.

export {}

type Doc = { [key: string]: any }

interface RootOperators extends Doc {
  $and?: Filter[]
  $where?: string | ((this: Doc) => boolean)
  $comment?: string | Doc
}

type Filter = { [key: string]: any } & RootOperators

function keysOf(filter: Filter): string[] {
  return Object.keys(filter)
}

function consume(doc: Doc): number {
  return Object.keys(doc).length
}

function find(filter: Filter): number {
  return consume(filter)
}

function whereKeys(filter: Filter): string {
  return Object.keys(filter).sort().join(',')
}

const keys = keysOf({ _id: 1, $comment: 'x' })
console.log('keys', keys.length, keys.join(','))
console.log('viewed', find({ _id: 7, title: 'a' }))
console.log('where', whereKeys({ $where: () => true, _id: 1 }))
console.log('where', whereKeys({ $where: 'this.a > 1' }))
