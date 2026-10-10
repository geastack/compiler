// A TYPED RECORD OR CLASS INSTANCE READ THROUGH AN OPEN `Document` PARAMETER.
//
// A binary-document serializer hands every nested document to `serializeInto` as a
// `Document` and reads `object[key]` for each key of `Object.keys(object)`.
// The view answers each read from the viewed object's declared-field
// dispatcher directly (`Value::readDeclaredField`), and only a key that
// dispatcher does not answer -- an expando, a prototype getter, a field the
// record leaves absent -- takes the full [[Get]]. Both halves must agree with
// the language: declared fields of a record and of a class instance, an
// optional field once set, an expando the program added and a missing key.

interface Doc {
  [key: string]: any
}

interface Todo {
  id: number
  title: string
  done: boolean
  tags?: string[]
}

class Counter {
  n = 1
  label = 'c'
}

function dump(d: Doc): string {
  const out: string[] = []
  for (const key of Object.keys(d)) out.push(`${key}=${JSON.stringify(d[key])}`)
  return out.join(' ')
}

function probe(d: Doc, key: string): string {
  return String(d[key])
}

const todo: Todo = { id: 7, title: 'x', done: true }

//! expect: id=7 title="x" done=true
console.log(dump(todo))

todo.tags = ['a', 'b']
//! expect: id=7 title="x" done=true tags=["a","b"]
console.log(dump(todo))

//! expect: absent:undefined
console.log('absent:' + probe(todo, 'nope'))

;(todo as any).extra = 5
//! expect: extra:5
console.log('extra:' + probe(todo, 'extra'))

const counter = new Counter()
//! expect: n=1 label="c" label:c
console.log(dump(counter) + ' label:' + probe(counter, 'label'))
