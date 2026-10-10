// The clone idiom `new this.constructor().copy( this )`, run from a base-class
// `clone` over a hierarchy where every subclass overrides `copy` with its own
// class as `source`: some overrides forward `( source, recursive )` to the base
// signature, others take only `( source )` and call `super.copy( source )`. A
// second, unrelated hierarchy (an owned settings object holding its own
// clonable child) uses the same idiom from its own `clone`, and the base node's
// recursive copy clones every child through the same dynamic constructor.

class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @return {Vec3}
   */
  set(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  /**
   * @param {Vec3} v
   * @return {Vec3}
   */
  copy(v) {
    this.x = v.x
    this.y = v.y
    this.z = v.z
    return this
  }
}

class TreeNode {
  constructor() {
    this.name = ''
    this.position = new Vec3()
    /** @type {Array<TreeNode>} */
    this.children = []
    /** @type {TreeNode | null} */
    this.parent = null
  }

  /**
   * @param {TreeNode} child
   * @return {TreeNode}
   */
  add(child) {
    child.parent = this
    this.children.push(child)
    return this
  }

  /**
   * @param {boolean} [recursive]
   * @return {TreeNode}
   */
  clone(recursive) {
    return new this.constructor().copy(this, recursive)
  }

  /**
   * @param {TreeNode} source
   * @param {boolean} [recursive=true]
   * @return {TreeNode}
   */
  copy(source, recursive = true) {
    this.name = source.name
    this.position.copy(source.position)
    if (recursive === true) {
      for (const child of source.children) {
        this.add(child.clone())
      }
    }
    return this
  }
}

class Group extends TreeNode {}

class Root extends TreeNode {
  constructor() {
    super()
    this.background = 0
  }

  /**
   * @param {Root} source
   * @param {boolean} [recursive]
   * @return {Root}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.background = source.background
    return this
  }
}

class Viewpoint extends TreeNode {
  /**
   * @param {Viewpoint} source
   * @param {boolean} [recursive]
   * @return {Viewpoint}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    return this
  }
}

class ConeViewpoint extends Viewpoint {
  constructor(fov = 50, aspect = 1, near = 0.1, far = 2000) {
    super()
    this.fov = fov
    this.aspect = aspect
    this.near = near
    this.far = far
  }

  /**
   * @param {ConeViewpoint} source
   * @param {boolean} [recursive]
   * @return {ConeViewpoint}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.fov = source.fov
    this.aspect = source.aspect
    this.near = source.near
    this.far = source.far
    return this
  }
}

class BoxViewpoint extends Viewpoint {
  constructor(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 2000) {
    super()
    this.left = left
    this.right = right
    this.top = top
    this.bottom = bottom
    this.near = near
    this.far = far
  }

  /**
   * @param {BoxViewpoint} source
   * @param {boolean} [recursive]
   * @return {BoxViewpoint}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.left = source.left
    this.right = source.right
    this.top = source.top
    this.bottom = source.bottom
    this.near = source.near
    this.far = source.far
    return this
  }
}

class Settings {
  /** @param {Viewpoint} view */
  constructor(view) {
    this.view = view
    this.bias = 0
  }

  /**
   * @param {Settings} source
   * @return {Settings}
   */
  copy(source) {
    this.view = source.view.clone()
    this.bias = source.bias
    return this
  }

  /** @return {Settings} */
  clone() {
    return new this.constructor().copy(this)
  }
}

class ConeSettings extends Settings {
  constructor() {
    super(new ConeViewpoint(50, 1, 0.5, 500))
    this.focus = 1
  }

  /**
   * @param {ConeSettings} source
   * @return {ConeSettings}
   */
  copy(source) {
    super.copy(source)
    this.focus = source.focus
    return this
  }
}

class BoxSettings extends Settings {
  constructor() {
    super(new BoxViewpoint(-5, 5, 5, -5, 0.5, 500))
  }
}

class Emitter extends TreeNode {
  constructor(color = 0xffffff, intensity = 1) {
    super()
    this.color = color
    this.intensity = intensity
  }

  /**
   * @param {Emitter} source
   * @param {boolean} [recursive]
   * @return {Emitter}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.color = source.color
    this.intensity = source.intensity
    return this
  }
}

class ConeEmitter extends Emitter {
  /**
   * @param {number} [color]
   * @param {number} [intensity]
   */
  constructor(color, intensity, distance = 0, angle = Math.PI / 3) {
    super(color, intensity)
    this.distance = distance
    this.angle = angle
    this.settings = new ConeSettings()
  }

  /**
   * @param {ConeEmitter} source
   * @param {boolean} [recursive]
   * @return {ConeEmitter}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.distance = source.distance
    this.angle = source.angle
    this.settings = /** @type {ConeSettings} */ (source.settings.clone())
    return this
  }
}

class ParallelEmitter extends Emitter {
  /**
   * @param {number} [color]
   * @param {number} [intensity]
   */
  constructor(color, intensity) {
    super(color, intensity)
    this.target = new TreeNode()
    this.settings = new BoxSettings()
  }

  /**
   * @param {ParallelEmitter} source
   * @return {ParallelEmitter}
   */
  copy(source) {
    super.copy(source)
    this.target = source.target.clone()
    this.settings = source.settings.clone()
    return this
  }
}

class PointEmitter extends Emitter {
  /**
   * @param {number} [color]
   * @param {number} [intensity]
   */
  constructor(color, intensity, distance = 0) {
    super(color, intensity)
    this.distance = distance
  }

  /**
   * @param {PointEmitter} source
   * @param {boolean} [recursive]
   * @return {PointEmitter}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.distance = source.distance
    return this
  }
}

class SkyEmitter extends Emitter {
  /**
   * @param {number} [color]
   * @param {number} [groundColor]
   * @param {number} [intensity]
   */
  constructor(color, groundColor = 0, intensity) {
    super(color, intensity)
    this.groundColor = groundColor
  }

  /**
   * @param {SkyEmitter} source
   * @param {boolean} [recursive]
   * @return {SkyEmitter}
   */
  copy(source, recursive) {
    super.copy(source, recursive)
    this.groundColor = source.groundColor
    return this
  }
}

class PanelEmitter extends Emitter {
  /**
   * @param {number} [color]
   * @param {number} [intensity]
   */
  constructor(color, intensity, width = 10, height = 10) {
    super(color, intensity)
    this.width = width
    this.height = height
  }

  /**
   * @param {PanelEmitter} source
   * @return {PanelEmitter}
   */
  copy(source) {
    super.copy(source)
    this.width = source.width
    this.height = source.height
    return this
  }
}

const cone = new ConeEmitter(0xffffff, 2, 10, 0.5)
cone.settings.bias = 0.25
const parallel = new ParallelEmitter(0xffffff, 3)
parallel.position.set(1, 2, 3)
const point = new PointEmitter(0xff0000, 1, 5)
const group = new Group()
group.add(cone)
group.add(parallel)
group.add(point)

const copy = group.clone()
const first = /** @type {ConeEmitter} */ (copy.children[0])
const second = /** @type {ParallelEmitter} */ (copy.children[1])
console.log(copy.children.length, first.intensity, second.position.y)
const coneCopy = /** @type {ConeEmitter} */ (cone.clone())
const coneView = /** @type {ConeViewpoint} */ (coneCopy.settings.view)
console.log(coneCopy.angle, coneCopy.settings.bias, coneView.fov)
const root = new Root()
root.add(new SkyEmitter(0xffffff, 0x000000, 0.75))
root.add(new PanelEmitter(0xffffff, 1, 4, 2))
root.add(new ConeViewpoint(60, 1, 0.1, 100))
root.add(new BoxViewpoint(-2, 2, 2, -2, 0, 10))
root.add(group)
const rootCopy = root.clone()
console.log(rootCopy.children.length)
const settingsCopy = parallel.settings.clone()
console.log(/** @type {BoxViewpoint} */ (settingsCopy.view).left)

//! expect: 3 2 2
//! expect: 0.5 0.25 50
//! expect: 5
//! expect: -5
