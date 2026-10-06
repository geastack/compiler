// @ts-nocheck
//! expect: has true true 1
//! expect: listening true
//! expect: listening false 0
//! expect: prefix 7
//! emitted-has: gea::bindCallable

// three's Renderer: `this._onCanvasTargetResize =
// this._onCanvasTargetResize.bind( this )` puts the method, bound to the same
// object, back into the slot of the same name, and the slot is then handed to
// `addEventListener` and `removeEventListener`. When the census cannot count
// that store, the renderer is an open object, so the `library` that
// `NodeLibrary.addType` receives from its two Map fields loses its type and
// `library.has` is a dynamic call. The bind with an argument prefix stays an
// uncounted use: what it stores takes a different parameter list.
//
// A module, as three's sources are: a script's top-level `renderer` is a
// global binding, whose method calls the census does not resolve with or
// without the bind.
//
// Nothing calls the listener: a method slot keeps the receiver-taking
// convention, so `listener()` and `listener.call(target)` cannot reach the
// bound function yet, and a direct `renderer._onCanvasTargetResize()` needs
// the slot's value reads ordered after the bind. Neither is this census.

export {}

class MaterialNode {}
class BasicNode {}

class Library {
  constructor() {
    /** @type {Map<string, Function>} */
    this.materialNodes = new Map()
    /** @type {Map<number, Function>} */
    this.toneMappingNodes = new Map()
  }

  addToneMapping(fn, toneMapping) {
    this.addType(fn, toneMapping, this.toneMappingNodes)
  }

  addMaterial(cls, type) {
    this.addType(cls, type, this.materialNodes)
  }

  /**
   * @param {Function} nodeClass
   * @param {number|string} type
   * @param {Map<number|string, Function>} library
   */
  addType(nodeClass, type, library) {
    if (library.has(type)) return
    library.set(type, nodeClass)
  }
}

class CanvasTarget {
  constructor() {
    this.listeners = []
  }

  addEventListener(type, listener) {
    this.listeners.push(listener)
  }

  removeEventListener(type, listener) {
    const index = this.listeners.indexOf(listener)
    if (index !== -1) this.listeners.splice(index, 1)
  }

  hasEventListener(type, listener) {
    return this.listeners.indexOf(listener) !== -1
  }
}

class Renderer {
  constructor(canvasTarget) {
    this.library = new Library()
    this.width = 1
    this.canvasTarget = canvasTarget
    this._onCanvasTargetResize = this._onCanvasTargetResize.bind(this)
    canvasTarget.addEventListener('resize', this._onCanvasTargetResize)
  }

  _onCanvasTargetResize() {
    this.width++
    console.log('resize', this.width, this.library.materialNodes.has('basic'))
  }

  dispose() {
    this.canvasTarget.removeEventListener('resize', this._onCanvasTargetResize)
  }
}

class Prefixed {
  constructor() {
    this.n = 3
    this.add = this.add.bind(this, 4)
  }

  add(x) {
    return this.n + x
  }
}

const canvasTarget = new CanvasTarget()
const renderer = new Renderer(canvasTarget)
renderer.library.addToneMapping(() => 1, 3)
renderer.library.addMaterial(MaterialNode, 'basic')
renderer.library.addMaterial(BasicNode, 'basic')
console.log(
  'has',
  renderer.library.toneMappingNodes.has(3),
  renderer.library.materialNodes.get('basic') === MaterialNode,
  renderer.library.materialNodes.size
)
console.log('listening', canvasTarget.hasEventListener('resize', renderer._onCanvasTargetResize))
renderer.dispose()
console.log('listening', canvasTarget.hasEventListener('resize', renderer._onCanvasTargetResize), canvasTarget.listeners.length)
console.log('prefix', new Prefixed().add())
