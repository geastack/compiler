//! expect: 42:0

class Cell<T> {
  items: T[] = []
}

const original = new Cell<string>()
const unrelated = new Cell<boolean>()
const view: { items: string[] | number[] } = original
view.items = [42]
console.log(`${original.items.join(',')}:${unrelated.items.length}`)
