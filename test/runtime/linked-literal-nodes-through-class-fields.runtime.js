// @ts-nocheck
//! expect: a,c c,a 2
// toad-cache's `FifoMap`: each entry is an object literal whose `prev` is the
// class's `last` field and whose `next` starts `null`; both fields, and every
// entry's links, are rewritten as entries come and go. A link read off an
// entry is an entry or `null`, never the bare `null` the literal wrote first.
class FifoMap {
  constructor () {
    this.items = new Map()
    this.first = null
    this.last = null
  }

  get size () { return this.items.size }

  set (key, value) {
    const item = { key, prev: this.last, next: null, value }
    this.items.set(key, item)
    if (this.size === 1) this.first = item
    else this.last.next = item
    this.last = item
  }

  delete (key) {
    const deletedItem = this.items.get(key)
    if (deletedItem !== undefined) {
      this.items.delete(key)
      if (deletedItem.prev !== null) deletedItem.prev.next = deletedItem.next
      if (deletedItem.next !== null) deletedItem.next.prev = deletedItem.prev
      if (this.first === deletedItem) this.first = deletedItem.next
      if (this.last === deletedItem) this.last = deletedItem.prev
    }
  }

  keys () {
    const forward = []
    for (let item = this.first; item !== null; item = item.next) forward.push(item.key)
    const backward = []
    for (let item = this.last; item !== null; item = item.prev) backward.push(item.key)
    return forward.join(',') + ' ' + backward.join(',')
  }
}
const cache = new FifoMap()
cache.set('a', 1)
cache.set('b', 2)
cache.set('c', 3)
cache.delete('b')
console.log(cache.keys(), cache.size)
