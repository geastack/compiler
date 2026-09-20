// hono's `RegExpRouter.match: typeof match<Router<T>, T> = match`: a generic
// function used as a VALUE, initializing a field whose declared type is an
// instantiation expression over that same generic. The field slot is one
// concrete signature; the initializer publishes the whole generic set.

interface Dispatcher<T> {
  name: string
  add(key: string, value: T): void
  lookup(key: string): T[]
}

export function lookup<R extends Dispatcher<T>, T>(this: R, key: string): T[] {
  const found: T[] = []
  for (const entry of (this as unknown as { entries: [string, T][] }).entries) {
    if (entry[0] === key) {
      found.push(entry[1])
    }
  }
  return found
}

class ListDispatcher<T> implements Dispatcher<T> {
  name: string = 'ListDispatcher'
  entries: [string, T][] = []

  add(key: string, value: T): void {
    this.entries.push([key, value])
  }

  lookup: typeof lookup<Dispatcher<T>, T> = lookup
}

const dispatcher = new ListDispatcher<number>()
dispatcher.add('a', 1)
dispatcher.add('b', 2)
dispatcher.add('a', 3)
console.log(dispatcher.lookup('a').length, dispatcher.lookup('b').length, dispatcher.lookup('c').length)
//! expect: 2 1 0
