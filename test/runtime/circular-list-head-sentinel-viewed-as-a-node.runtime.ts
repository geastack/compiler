// A circularly linked list whose head is one literal allocation seen as an
// empty sentinel (`value: null`, linked to itself) and, once nodes exist, as
// a head whose neighbours are nodes. Every node links back to that head, so
// the same object is read and written through both shapes.

export {}

type ListNode<T> = {
  value: T
  next: ListNode<T> | HeadNode<T>
  prev: ListNode<T> | HeadNode<T>
}

type HeadNode<T> = {
  value: null
  next: ListNode<T>
  prev: ListNode<T>
}

type EmptyNode = {
  value: null
  next: EmptyNode
  prev: EmptyNode
}

class List<T = unknown> {
  private readonly head: HeadNode<T> | EmptyNode
  private count: number

  get length() {
    return this.count
  }

  constructor() {
    this.count = 0
    this.head = {
      next: null,
      prev: null,
      value: null
    } as unknown as EmptyNode
    this.head.next = this.head
    this.head.prev = this.head
  }

  toArray(): T[] {
    return Array.from(this)
  }

  *[Symbol.iterator](): Generator<T, void, void> {
    for (const node of this.nodes()) yield node.value
  }

  private *nodes(): Generator<ListNode<T>, void, void> {
    let ptr: HeadNode<T> | ListNode<T> | EmptyNode = this.head.next
    while (ptr !== this.head) {
      const { next } = ptr as ListNode<T>
      yield ptr as ListNode<T>
      ptr = next
    }
  }

  push(value: T) {
    this.count += 1
    const newNode: ListNode<T> = {
      next: this.head as HeadNode<T>,
      prev: this.head.prev as ListNode<T>,
      value
    }
    this.head.prev.next = newNode
    this.head.prev = newNode
  }

  unshift(value: T) {
    this.count += 1
    const newNode: ListNode<T> = {
      next: this.head.next as ListNode<T>,
      prev: this.head as HeadNode<T>,
      value
    }
    this.head.next.prev = newNode
    this.head.next = newNode
  }

  private remove(node: ListNode<T> | EmptyNode): T | null {
    if (node === this.head || this.length === 0) return null
    this.count -= 1
    const prevNode = node.prev
    const nextNode = node.next
    prevNode.next = nextNode
    nextNode.prev = prevNode
    return node.value
  }

  shift(): T | null {
    return this.remove(this.head.next)
  }

  pop(): T | null {
    return this.remove(this.head.prev)
  }

  clear() {
    this.count = 0
    this.head.next = this.head as EmptyNode
    this.head.prev = this.head as EmptyNode
  }

  first(): T | null {
    return this.head.next.value
  }

  last(): T | null {
    return this.head.prev.value
  }
}

class Chunk {
  constructor(readonly bytes: number) {}
}

const chunks = new List<Chunk>()
console.log(chunks.length, chunks.first() === null, chunks.shift() === null)
chunks.push(new Chunk(3))
chunks.push(new Chunk(5))
chunks.unshift(new Chunk(1))
console.log(chunks.length, chunks.first()?.bytes, chunks.last()?.bytes)
console.log(
  chunks
    .toArray()
    .map((chunk) => chunk.bytes)
    .join(',')
)
console.log(chunks.shift()?.bytes, chunks.pop()?.bytes, chunks.length)
chunks.clear()
console.log(chunks.length, chunks.first() === null, chunks.toArray().length)

const names = new List<string>()
names.push('a')
names.push('b')
console.log(names.toArray().join('|'), names.pop(), names.length)

interface WaitQueueMember {
  readonly id: number
  cancelled?: boolean
}

const waiting = new List<WaitQueueMember>()
waiting.push({ id: 7 })
waiting.push({ id: 8, cancelled: true })
console.log(waiting.first()?.id, waiting.last()?.cancelled, waiting.shift()?.id, waiting.length)

const buffers = new List<Uint8Array>()
buffers.push(new Uint8Array([1, 2]))
buffers.unshift(new Uint8Array([9]))
console.log(
  buffers.first()?.length,
  buffers
    .toArray()
    .map((bytes) => bytes[0])
    .join(',')
)

const loose = new List<any>()
loose.push({ k: 1 })
loose.unshift(2)
console.log(loose.length, JSON.stringify(loose.first()), JSON.stringify(loose.last()))

const untyped = new List()
untyped.push(4)
untyped.push('x')
console.log(untyped.length, untyped.toArray().join('/'))

class Pool {
  private waitQueue: List<WaitQueueMember>
  private buffers: List<Uint8Array>
  constructor() {
    this.waitQueue = new List()
    this.buffers = new List()
  }
  enqueue(member: WaitQueueMember, bytes: Uint8Array) {
    this.waitQueue.push(member)
    this.buffers.push(bytes)
  }
  describe(): string {
    return `${this.waitQueue.length}:${this.waitQueue.first()?.id}:${this.buffers.first()?.length}`
  }
}

interface SelectionRequest {
  readonly topology: Topology
  resolve: (picked: number) => void
  cancelled: boolean
}

class Topology {
  readonly waitQueue: List<SelectionRequest>
  picked: number[] = []
  constructor() {
    this.waitQueue = new List()
  }
  select(id: number) {
    const request: SelectionRequest = { topology: this, resolve: (picked) => this.picked.push(picked * id), cancelled: false }
    this.waitQueue.push(request)
  }
  drain() {
    while (this.waitQueue.length > 0) {
      const request = this.waitQueue.shift()
      if (request && !request.cancelled) request.resolve(request.topology.picked.length + 1)
    }
    return this.picked.join(',')
  }
}

const topology = new Topology()
topology.select(10)
topology.select(20)
console.log(topology.drain())

const pool = new Pool()
pool.enqueue({ id: 3 }, new Uint8Array(4))
console.log(pool.describe())

//! expect: 0 true true
//! expect: 3 1 5
//! expect: 1,3,5
//! expect: 1 5 1
//! expect: 0 true 0
//! expect: a|b b 1
//! expect: 7 true 7 1
//! expect: 1 9,1
//! expect: 2 2 {"k":1}
//! expect: 2 4/x
//! expect: 10,40
//! expect: 1:3:4
