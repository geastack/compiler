// A promise whose fulfilment is boxed, read as a promise of a named
// interface: a database client's `findOne` resolves `Promise<WithId<TSchema> | null>`
// with a deserialized wire-format Document. An interface is a named layout
// (`native-record-ref`), and the promise-payload read resolved it by identity
// alone -- every Document aborted with "an assertion out of a dynamic value".
// It is read through a live Document view, as a plain `any -> Todo` read is:
// a cast checks nothing in JS, so a mistyped field that is never read is
// accepted exactly as Node accepts it.
interface Todo {
  title: string
  done: boolean
  tags?: string[]
}

const fetchRaw = async (text: string): Promise<any> => JSON.parse(text)

const findOne = (text: string): Promise<Todo | null> => fetchRaw(text) as Promise<Todo | null>

const describe = (todo: Todo | null): string =>
  todo === null ? 'none' : `${todo.title}:${String(todo.done)}:${todo.tags?.join('+') ?? '-'}`

const main = async (): Promise<void> => {
  console.log(describe(await findOne('{"title":"a","done":true}')))
  console.log(describe(await findOne('{"title":"b","done":false,"tags":["x","y"]}')))
  console.log(describe(await findOne('null')))
  try {
    await findOne('{"title":1,"done":true}')
    console.log('accepted')
  } catch (error) {
    console.log(error instanceof TypeError ? 'TypeError' : 'other')
  }
}

void main()

//! expect: a:true:-
//! expect: b:false:x+y
//! expect: none
//! expect: accepted
