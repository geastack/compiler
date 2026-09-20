//! expect: 2 0
// The same composite filling, spelled through an INHERITED member. The open
// side of the pairing has to come from the reference's own TARGET (`Box<T>`,
// whose `entries` is the base's member instantiated with the DERIVED class's
// parameter) and not from the member's declaration, which spells the BASE's
// parameter instead and pairs against nothing the derived body ever writes.
type WithCount<T> = [T, number]

function firstOf<T>(items: T[] | undefined): T[] | undefined {
  if (!items) {
    return undefined
  }
  return [...items]
}

class BaseBox<T> {
  entries: Record<string, WithCount<T>[]>
  constructor(entries: Record<string, WithCount<T>[]>) {
    this.entries = entries
  }
}

class Box<T> extends BaseBox<T> {
  pick(key: string): WithCount<T>[] {
    return firstOf(this.entries[key]) || []
  }
}

const box = new Box<number>({
  a: [
    [1, 0],
    [2, 0]
  ]
})
console.log(box.pick('a').length, box.pick('c').length)
