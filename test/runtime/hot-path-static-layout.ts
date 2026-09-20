// A final root class the program evaluates once, whose fields nothing deletes
// or freezes, in a program with no integrity operation. Its struct must be
// exactly its fields: the method state, the presence bits and the attribute
// triples are program-wide constants and are stated once (`static`), and the
// protocol members dispatch statically (no vptr) because no other type can be
// behind a handle to a class nothing derives from. That is the shape behind
// `bench/comparison/fixtures/binary_trees.ts`, whose node was a 64-byte pool
// cell against a 24-byte hand-written one before this.
class Link {
  value: number
  next: Link | null
  constructor(value: number, next: Link | null) {
    this.value = value
    this.next = next
  }
}

function build(count: number): Link | null {
  let head: Link | null = null
  for (let i = 0; i < count; i++) head = new Link(i, head)
  return head
}

function sum(node: Link | null): number {
  let total = 0
  for (let at = node; at !== null; at = at.next) total += at.value
  return total
}

const list = build(20000)
const first = new Link(1, null)
console.log(sum(list), first instanceof Link, 'value' in first, 'next' in first, Object.keys(first).join(','))
