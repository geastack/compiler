// A 3D scene-graph library's box geometry `copy( source ) { this.parameters = Object.assign( {},
// source.parameters ) }`, where `parameters` is declared `@type {Object}` --
// TypeScript's `Object` interface, not a record -- and the subclass's own
// constructor fills it with a literal. The stock bulk assignment copies the
// source's own keys into a fresh object.
class Geometry {
  constructor() {
    this.type = 'Geometry'
  }
  /**
   * @param {Geometry} source
   * @return {Geometry}
   */
  copy(source) {
    this.type = source.type
    return this
  }
}
class Box extends Geometry {
  /**
   * @param {number} [width=1]
   * @param {number} [height=1]
   */
  constructor(width = 1, height = 1) {
    super()
    this.type = 'Box'
    /** @type {Object} */
    this.parameters = {
      width: width,
      height: height
    }
  }
  /**
   * @param {Box} source
   * @return {Box}
   */
  copy(source) {
    super.copy(source)
    this.parameters = Object.assign({}, source.parameters)
    return this
  }
}

const box = new Box(3, 4)
const copy = new Box().copy(box)
console.log(copy.type, JSON.stringify(copy.parameters), copy.parameters === box.parameters)

//! expect: Box {"width":3,"height":4} false
