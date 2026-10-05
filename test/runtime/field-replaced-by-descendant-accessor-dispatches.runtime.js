// @ts-nocheck
//! expect: read 1|B:x|5
//! expect: write 2|B:y|c
//! expect: setter init,y
//! expect: plain 9 10
//! expect: through base 3|T:t
//! expect: base setter ctor
// The reverse of `member-replaced-by-descendant-accessor-is-not-restated`:
// three's `InputNode` stores `this.value = value` as a data field and
// `TextureNode` replaces `value` with `get value()` / `set value()`. The
// accessor lives on the subclass's prototype, so on a TextureNode the base
// constructor's own `this.value = value` runs the setter, and a read or write
// through a receiver typed as the base reaches the accessor, not a field.
// `C` does not replace the field: through its own type it stays a plain field.
// `GNode` declares no `value`, but `holder.node.value` reads it through one, so
// the base keeps the slot for its descendants' member; InNode's stores land in
// that slot, and TexNode's accessor replaces it all the same.
const log = []
class A {
  /** @param {any} v */
  constructor(v) {
    /** @type {any} */
    this.value = v
  }
}
class B extends A {
  /** @param {string} t */
  constructor(t) {
    super('init')
    /** @type {string} */
    this._v = t
  }
  set value(x) {
    log.push(String(x))
    this._v = String(x)
  }
  /** @type {string} */
  get value() {
    return 'B:' + this._v
  }
}
class C extends A {
  /** @param {number} n */
  constructor(n) {
    super(n)
    /** @type {number} */
    this.extra = 1
  }
}
/** @type {A[]} */
const list = [new A(1), new B('x'), new C(5)]
console.log('read ' + list.map((item) => String(item.value)).join('|'))
list[0].value = 2
list[1].value = 'y'
list[2].value = 'c'
console.log('write ' + list.map((item) => String(item.value)).join('|'))
console.log('setter ' + log.join(','))
const plain = new C(9)
const before = plain.value
plain.value = 10
console.log('plain ' + String(before) + ' ' + String(plain.value))
const baseLog = []
class GNode {}
class InNode extends GNode {
  /** @param {any} v */
  constructor(v) {
    super()
    /** @type {any} */
    this.value = v
  }
}
class TexNode extends InNode {
  constructor() {
    super('ctor')
    /** @type {string} */
    this._t = 't'
  }
  set value(x) {
    baseLog.push(String(x))
    this._t = String(x)
  }
  /** @type {string} */
  get value() {
    return 'T:' + this._t
  }
}
class Holder {
  /** @param {GNode} node */
  constructor(node) {
    /** @type {GNode} */
    this.node = node
  }
}
const holders = [new Holder(new InNode(3)), new Holder(new TexNode())]
console.log('through base ' + holders.map((holder) => String(holder.node.value)).join('|'))
console.log('base setter ' + baseLog.join(','))
