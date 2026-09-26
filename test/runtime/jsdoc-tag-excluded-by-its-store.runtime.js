// @ts-nocheck
//! expect: false true 3
//! expect: x none true false
// A field `@type` or a `@return` that the stored or returned value's own
// statement excludes: three's `InterleavedBufferAttribute` tags
// `this.normalized` `{InterleavedBuffer}` over a `@param {boolean}`;
// `MemberNode` tags `this.property` `{Node}` over a `@param {string}`;
// `Node.getUpdateType` returns its `{string}` field under `@return
// {NodeUpdateType}`, the constants object; `MRTNode.has` returns a comparison
// under `@return {NodeBuilder}`. The store is what the program does.
const UpdateType = { NONE: 'none', FRAME: 'frame' }
class Store {
  constructor(count) {
    this.count = count
  }
}
class View {
  /**
   * @param {Store} data
   * @param {boolean} [normalized=false]
   */
  constructor(data, normalized = false) {
    /** @type {Store} */
    this.data = data
    /** @type {Store} */
    this.normalized = normalized
  }
  clone() {
    return new View(this.data, this.normalized)
  }
}
class Member {
  /** @param {string} property */
  constructor(property) {
    /** @type {View} */
    this.property = property
    /** @type {string} */
    this.updateType = UpdateType.NONE
  }
  /** @return {UpdateType} */
  getUpdateType() {
    return this.updateType
  }
  /**
   * @param {string} name
   * @return {View}
   */
  has(name) {
    return this.property === name
  }
}
const view = new View(new Store(3))
const flagged = new View(new Store(3), true)
console.log(String(view.clone().normalized) + ' ' + String(flagged.normalized) + ' ' + view.data.count)
const member = new Member('x')
console.log(member.property + ' ' + member.getUpdateType() + ' ' + String(member.has('x')) + ' ' + String(member.has('y')))
