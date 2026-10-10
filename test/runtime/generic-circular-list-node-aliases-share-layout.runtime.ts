// THREE NODE ALIASES THAT ARE VIEWS OF ONE OBJECT, ACROSS SEVERAL GENERIC COPIES.
//
// A database client's `List<T>` is a circular doubly linked list whose head
// is `{ next: null, prev: null, value: null } as unknown as EmptyNode`, typed
// `HeadNode<T> | EmptyNode`, and whose nodes are `ListNode<T>` literals. The
// head's links point at nodes and the nodes' links point back at the head, so
// `ListNode<T>`, `HeadNode<T>` and the non-generic `EmptyNode` all name one
// kind of object: `{ next, prev, value }`. Laid out as three structs (and a
// fresh pair per copy of `List`) every link store carries one record into
// another's field, which no conversion can do without breaking identity.
//
// Two copies (`List<Job>`, `List<string>`) share the one non-generic
// `EmptyNode`.

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

  get length(): number {
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

  private *nodes(): Generator<ListNode<T>, void, void> {
    let ptr: HeadNode<T> | ListNode<T> | EmptyNode = this.head.next
    while (ptr !== this.head) {
      const { next } = ptr as ListNode<T>
      yield ptr as ListNode<T>
      ptr = next
    }
  }

  push(value: T): void {
    this.count += 1
    const newNode: ListNode<T> = {
      next: this.head as HeadNode<T>,
      prev: this.head.prev as ListNode<T>,
      value
    }
    this.head.prev.next = newNode
    this.head.prev = newNode
  }

  unshift(value: T): void {
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
    if (node === this.head || this.length === 0) {
      return null
    }
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

  prune(filter: (value: T) => boolean): void {
    for (const node of this.nodes()) {
      if (filter(node.value)) {
        this.remove(node)
      }
    }
  }

  clear(): void {
    this.count = 0
    this.head.next = this.head as EmptyNode
    this.head.prev = this.head as EmptyNode
  }

  values(): T[] {
    const out: T[] = []
    for (const node of this.nodes()) out.push(node.value)
    return out
  }

  first(): T | null {
    return this.head.next.value
  }

  last(): T | null {
    return this.head.prev.value
  }
}

class Job {
  readonly id: number
  constructor(id: number) {
    this.id = id
  }
}

const jobs = new List<Job>()
jobs.push(new Job(2))
jobs.push(new Job(3))
jobs.unshift(new Job(1))
const ids = jobs.values().map((job) => job.id)
//! expect: jobs=1,2,3 length=3 first=1 last=3
console.log(`jobs=${ids.join(',')} length=${jobs.length} first=${jobs.first()?.id} last=${jobs.last()?.id}`)

jobs.prune((job) => job.id === 2)
const shifted = jobs.shift()
const popped = jobs.pop()
//! expect: shifted=1 popped=3 length=0 empty=null
console.log(`shifted=${shifted?.id} popped=${popped?.id} length=${jobs.length} empty=${jobs.shift()}`)

const names = new List<string>()
names.push('b')
names.unshift('a')
names.push('c')
const seen = names.values()
//! expect: names=a,b,c first=a last=c
console.log(`names=${seen.join(',')} first=${names.first()} last=${names.last()}`)
names.clear()
//! expect: cleared length=0 first=null pop=null
console.log(`cleared length=${names.length} first=${names.first()} pop=${names.pop()}`)
