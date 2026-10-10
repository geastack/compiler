// A class instance returned where `AsyncIterable<T>` is declared -- a database
// client's `StateMachine.fetchCollectionInfo` returns a `ListCollectionsCursor` as
// `AsyncIterable<CollectionInfo>`, and the async generator method that makes
// it one is declared on the cursor's BASE class.
//
// The class's `async *[Symbol.asyncIterator]` publishes the generator's
// `iterator` carrier, while the interface's member returns an
// `AsyncIterator<T>` RECORD. The generator object IS that async iterator, so
// the record view preserves the method and supplies its authenticated native
// origin when called through the view. Its cursor becomes the iterator object
// (`conversion/iterator-object-view.ts`), with `next` answering a promise of the
// step's record.
//! expect: a,b,c
//! expect: 3 true

interface Info {
  name: string
}

abstract class Cursor<T> {
  protected items: T[]
  constructor(items: T[]) {
    this.items = items
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    for (const item of this.items) yield item
  }
}

class ListCursor<T extends Info = Info> extends Cursor<T> {
  readonly label = 'list'
}

function fetchInfo(names: string[]): AsyncIterable<Info> {
  const cursor = new ListCursor(names.map((name) => ({ name })))
  return cursor
}

async function main(): Promise<void> {
  const seen: string[] = []
  for await (const info of fetchInfo(['a', 'b', 'c'])) seen.push(info.name)
  // node prints: a,b,c
  console.log(seen.join(','))
  // The view's `next` steps the one live cursor; node prints: 3 true
  const iterator = fetchInfo(['x', 'y', 'z'])[Symbol.asyncIterator]()
  let count = 0
  let step = await iterator.next()
  while (!step.done) {
    count++
    step = await iterator.next()
  }
  console.log(count, step.done)
}
void main()
