// A NULL-FIELD LITERAL ASSERTED INTO A SELF-REFERENTIAL NODE, THEN LINKED.
//
// A database client's `List` builds its circular head as
// `{ next: null, prev: null, value: null } as unknown as EmptyNode` and links
// `head.next`/`head.prev` to the head itself on the next two lines. The literal
// holds `null` in both links only until those writes; afterwards the empty
// list's head points at itself.
//
// Only the empty ring is exercised here: pushing a `ListNode` into the head's
// links stores one record type into another's reference field, which needs
// the three node aliases to share one physical layout (identity must survive
// the store) and is refused by name today.

type EmptyNode = {
  value: null
  next: EmptyNode
  prev: EmptyNode
}

class Ring {
  private readonly head: EmptyNode
  private count: number

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

  get length(): number {
    return this.count
  }

  isLinkedToItself(): boolean {
    return this.head.next === this.head && this.head.prev === this.head && this.head.next.next === this.head
  }

  headValue(): null {
    return this.head.value
  }
}

const ring = new Ring()
//! expect: empty=true length=0 value=null
console.log(`empty=${ring.isLinkedToItself()} length=${ring.length} value=${ring.headValue()}`)
