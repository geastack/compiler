// @ts-nocheck
//! expect: 6 0
//! expect: true undefined true
// three's math classes state their type flag once, on the prototype, from
// their own static block: `static { Vector2.prototype.isVector2 = true }`.
// That store installs a primitive and hands the constructor nowhere, so the
// class still owns every instance it constructs, and a read over the family
// (`point.z || 0` with `point` a `Vector2 | Vector3`) is a family read: the
// Vector2 arm has no `z`. BufferGeometry.setFromPoints is this shape.
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
const geometry = new Geometry()
const v2 = new Vector2(1, 2)
console.log(geometry.setFromPoints([new Vector3(1, 2, 3), new Vector3(4, 5, 6)]).array.length, geometry.setFromPoints([v2]).array[2])
console.log(v2.isVector2, v2.isVector3, new Vector3().isVector3)
