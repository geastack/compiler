// @ts-nocheck
//! expect: x none L:y
// three's `Node` states `@type {string} this.name = ''` and `ReferenceNode`
// re-assigns it `@type {?string} this.name = null`. One property, one slot on
// every node, and the checker joins the subclass's tag into the ancestor's
// member. The subclass overlay must not restate the member on the subclass:
// a second declaration there typed the subclass's writes `string | null`
// while the slot stayed the ancestor's `string`, and the `null` store had no
// conversion.
class GNode {
  constructor() {
    /**
     * @type {string}
     * @default ''
     */
    this.name = ''
  }
  /** @param {string} name */
  setName(name) {
    this.name = name
    return this
  }
}
class RefNode extends GNode {
  constructor() {
    super()
    /**
     * @type {?string}
     * @default null
     */
    this.name = null
  }
  label() {
    return this.name !== null ? 'L:' + this.name : 'none'
  }
}
const a = new GNode().setName('x')
const r = new RefNode()
const before = r.label()
r.name = 'y'
console.log(a.name + ' ' + before + ' ' + r.label())
