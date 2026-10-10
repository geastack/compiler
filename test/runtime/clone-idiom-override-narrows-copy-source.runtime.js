// A 3D scene-graph library's `SceneNode.clone( recursive ) { return new
// this.constructor().copy( this, recursive ) }` read as a VALUE off the fresh instance: `.copy` is the
// base declaration's `(source: SceneNode, recursive?) => SceneNode` slot, while
// every subclass override takes its own class (`Camera.copy( source,
// recursive )`). Reading an override into the base slot needs the source
// argument carried back to the override's own class.
class Thing {
  constructor() {
    this.name = 'node'
    this.children = []
  }
  /**
   * @param {Thing} source
   * @param {boolean} [recursive=true]
   * @return {Thing}
   */
  copy(source, recursive = true) {
    this.name = source.name
    if (recursive === true) for (const child of source.children) this.children.push(child.clone())
    return this
  }
  /**
   * @param {boolean} [recursive=true]
   * @return {Thing}
   */
  clone(recursive) {
    return new this.constructor().copy(this, recursive)
  }
}
class Lens extends Thing {
  constructor() {
    super()
    this.zoom = 1
  }
  /**
   * @param {Lens} source
   * @param {boolean} [recursive]
   * @return {Lens}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.zoom = source.zoom
    return this
  }
  clone() {
    return new this.constructor().copy(this)
  }
}
class Lamp extends Thing {
  constructor() {
    super()
    this.power = 0
  }
  /**
   * @param {Lamp} source
   * @return {Lamp}
   */
  copy(source) {
    super.copy(source, false)
    this.power = source.power
    return this
  }
}

const root = new Thing()
root.name = 'root'
const lens = new Lens()
lens.name = 'lens'
lens.zoom = 3
const lamp = new Lamp()
lamp.name = 'lamp'
lamp.power = 60
root.children.push(lens)
root.children.push(lamp)
const copy = root.clone()
console.log(copy.name, copy.children.length, copy.children[0].name, copy.children[1].name)
const lensCopy = lens.clone()
console.log(lensCopy.name, lensCopy.zoom, lensCopy instanceof Lens)
const lampCopy = lamp.clone(false)
console.log(lampCopy.name, lampCopy.power, lampCopy instanceof Lamp)

//! expect: root 2 lens lamp
//! expect: lens 3 true
//! expect: lamp 60 true
