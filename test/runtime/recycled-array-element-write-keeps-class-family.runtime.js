// @ts-nocheck
//! expect: true 2 0.25
//! expect: 6 0
// three's RenderList recycles its render items: `let renderItem =
// this.renderItems[ i ]`, a field stated `@type {Array<Object>}`, then
// `renderItem.z = z`. `Object` states nothing about what the array holds, so
// that write blocked the family read `point.z || 0` (a `Vector2 | Vector3`
// point, BufferGeometry.setFromPoints) as a possible expando on a Vector2.
// Every value the array ever stored is the item literal or the item read back
// out of it, so the write names no class instance and the read is a family
// read: the Vector2 arm has no `z`.
class Vector2 {
  static {
    /** @type {boolean} */
    Vector2.prototype.isVector2 = true
  }
  constructor(x = 0, y = 0) {
    /** @type {number} */
    this.x = x
    /** @type {number} */
    this.y = y
  }
}
class Vector3 {
  static {
    /** @type {boolean} */
    Vector3.prototype.isVector3 = true
  }
  constructor(x = 0, y = 0, z = 0) {
    /** @type {number} */
    this.x = x
    /** @type {number} */
    this.y = y
    /** @type {number} */
    this.z = z
  }
}
class Attribute {
  /**
   * @param {(Array<number>|Float32Array)} array
   * @param {number} itemSize
   */
  constructor(array, itemSize) {
    this.array = new Float32Array(array)
    this.itemSize = itemSize
  }
}
class Geometry {
  /**
   * @param {Array<Vector2>|Array<Vector3>} points
   * @return {Attribute}
   */
  setFromPoints(points) {
    const position = []
    for (let i = 0, l = points.length; i < l; i++) {
      const point = points[i]
      position.push(point.x, point.y, point.z || 0)
    }
    return new Attribute(position, 3)
  }
}
class RenderList {
  constructor() {
    /** @type {Array<Object>} */
    this.renderItems = []
    /** @type {number} */
    this.renderItemsIndex = 0
  }
  /**
   * @param {number} id
   * @param {number} z
   * @return {Object}
   */
  getNextRenderItem(id, z) {
    let renderItem = this.renderItems[this.renderItemsIndex]
    if (renderItem === undefined) {
      renderItem = { id: id, z: z }
      this.renderItems[this.renderItemsIndex] = renderItem
    } else {
      renderItem.id = id
      renderItem.z = z
    }
    this.renderItemsIndex++
    return renderItem
  }
  finish() {
    for (let i = this.renderItemsIndex, il = this.renderItems.length; i < il; i++) {
      const renderItem = this.renderItems[i]
      if (renderItem.id === null) break
      renderItem.id = null
      renderItem.z = null
    }
    this.renderItemsIndex = 0
  }
}
const list = new RenderList()
const item = list.getNextRenderItem(1, 0.5)
list.finish()
const again = list.getNextRenderItem(2, 0.25)
console.log(item === again, again.id, again.z)
const geometry = new Geometry()
const v2 = new Vector2(1, 2)
console.log(geometry.setFromPoints([new Vector3(1, 2, 3), new Vector3(4, 5, 6)]).array.length, geometry.setFromPoints([v2]).array[2])
