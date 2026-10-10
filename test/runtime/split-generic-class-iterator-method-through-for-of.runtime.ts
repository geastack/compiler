// A generic class instantiated at two layout-distinct types is two physical
// classes; iterating either with for-of reads its own copy's [Symbol.iterator]
// (a database client's List<T>, iterated as List<Connection> and List<Session>).
class Node<T> {
  constructor(
    readonly value: T,
    public next: Node<T> | null = null
  ) {}
}

class List<T = unknown> {
  private head: Node<T> | null = null
  private tail: Node<T> | null = null
  count = 0

  push(value: T): void {
    const node = new Node(value)
    if (this.tail === null) this.head = node
    else this.tail.next = node
    this.tail = node
    this.count++
  }

  *[Symbol.iterator](): Generator<T, void, void> {
    for (let node = this.head; node !== null; node = node.next) yield node.value
  }
}

class Connection {
  constructor(readonly id: number) {}
}

const connections = new List<Connection>()
connections.push(new Connection(1))
connections.push(new Connection(2))
const names = new List<string>()
names.push('a')
names.push('b')
names.push('c')
const ids: number[] = []
for (const connection of connections) ids.push(connection.id)
let joined = ''
for (const name of names) joined += name
console.log(ids.join(','), joined, connections.count + names.count)
//! expect: 1,2 abc 5
export {}
