//! dynamic-fallback
//! expect: 3 2 a b a undefined
// toad-cache's FIFO: a JavaScript class declares `first`, `last` and `items`
// by assignment in its constructor (`null`, `null`, `new Map()`), and later
// writes store nodes that read the fields back. The class layout stores each
// field as the census joins every write to it, the same answer each read and
// write of it gets -- not as the constructor's first value.
'use strict'
class FifoMap {
  constructor () {
    this.first = null
    this.items = new Map()
    this.last = null
  }
  set (key, value) {
    const existing = this.items.get(key)
    if (existing !== undefined) {
      existing.value = value
      return
    }
    const item = { key: key, prev: this.last, value }
    this.items.set(key, item)
    if (this.first === null) this.first = item
    this.last = item
  }
  get (key) {
    const item = this.items.get(key)
    return item === undefined ? undefined : item.value
  }
}
const m = new FifoMap()
m.set('a', 1)
m.set('b', 2)
m.set('a', 3)
console.log(m.get('a'), m.get('b'), m.first.key, m.last.key, m.last.prev.key, m.get('c'))
