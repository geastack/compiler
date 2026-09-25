// @ts-nocheck
//! expect: b,c,a
//! expect: b,c,a|b,c,a

// A field whose only TYPED writes are the `null` placeholder it starts from.
//
// three's `Node` (`nodes/core/Node.js`) keeps `_beforeNodes` this way: `null`
// in the constructor, `[]` in `before()`, and in `build()` a copy taken, the
// field set back to `null` while the copy is walked, then restored. The `[]`
// write is silent to the field census (its element is what `push` puts
// through the field itself) and so is the restore (a copy of the field). The
// lenient retry used to join the writes that did speak -- both `null` -- and
// bound the field to `null`, so `for ( const beforeNode of currentBeforeNodes )`
// was a loop over `null`, refused as "the source declares no @@iterator chain".
// The placeholder alone exhausts nothing; the field stays unstated (`any`) and
// the loop walks it through the dynamic iterator protocol. The field's layout
// and its reads agree on that: both ask the field at the left-hand side of its
// declaring assignment, not at the assignment (whose value is the first
// write's `null`).
class Leaf {
  constructor(name) {
    this.name = name
    this._beforeNodes = null
  }
  before(node) {
    if (this._beforeNodes === null) this._beforeNodes = []
    this._beforeNodes.push(node)
    return this
  }
  build(out) {
    if (this._beforeNodes !== null) {
      const currentBeforeNodes = this._beforeNodes
      this._beforeNodes = null
      for (const beforeNode of currentBeforeNodes) {
        beforeNode.build(out)
      }
      this._beforeNodes = currentBeforeNodes
    }
    out.push(this.name)
  }
}
const root = new Leaf('a')
root.before(new Leaf('b')).before(new Leaf('c'))
const first = []
root.build(first)
console.log(first.join(','))
const second = []
root.build(second)
console.log(first.join(',') + '|' + second.join(','))
