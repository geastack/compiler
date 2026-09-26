// @ts-nocheck
//! expect: uuid u-1 u-1 true
//! expect: unnamed
//! expect: named color
// three's `Node._uuid` and `ReferenceNode.name`: a field tagged `@type
// {string}` and initialized `null` until something fills it. The tag leaves
// `null` out, the program stores it; the field holds it until the next store,
// and the reads that test for it see it.
let counter = 0
class Thing {
  constructor() {
    /**
     * @type {string}
     * @default null
     */
    this._uuid = null
    /** @type {string} */
    this.name = null
  }
  /** @type {string} */
  get uuid() {
    if (this._uuid === null) this._uuid = 'u-' + ++counter
    return this._uuid
  }
  /** @param {string} name */
  setName(name) {
    this.name = name
    return this
  }
  /** @return {string} */
  describe() {
    return this.name !== null ? 'named ' + this.name : 'unnamed'
  }
}
const thing = new Thing()
const first = thing.uuid
console.log('uuid ' + first + ' ' + thing.uuid + ' ' + (first === thing.uuid))
console.log(thing.describe())
console.log(thing.setName('color').describe())
