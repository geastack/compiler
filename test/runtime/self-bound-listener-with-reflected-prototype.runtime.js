// @ts-nocheck
//! expect: descriptors opacity:get
//! expect: resize renderer 1 640
//! expect: resize renderer 2 800
//! expect: resize renderer 3 800
//! expect: resize renderer 4 800
//! expect: resize renderer 5 1024
//! emitted-has: gea::refuseSelfBoundPrototypeRead
//! expect: listeners 1 1

// three's Renderer stores `this._onCanvasTargetResize =
// this._onCanvasTargetResize.bind(this)` in its constructor and hands the
// slot to a CanvasTarget's EventDispatcher, which calls `listener.call(this,
// event)` with the CanvasTarget as `this`. The same program reflects over a
// class prototype (`Object.getOwnPropertyDescriptors`, as three's
// `RenderObject.getKeys` does), so every class gets a native prototype object
// whose method slot holds the original, unbound method.
//
// The slot keeps one storage convention, which takes a receiver: the native
// prototype object's slot holds the unbound method. The reads the self-bind
// proof covers -- through `this` in the class's own members -- see the bound
// function, which ignores the dispatch receiver. `setCanvasTarget` removes
// the listener it added: the two reads of the slot are one function.

export {}

class EventDispatcher {
  addEventListener(type, listener) {
    if (this._listeners === undefined) this._listeners = {}
    const listeners = this._listeners
    if (listeners[type] === undefined) listeners[type] = []
    if (listeners[type].indexOf(listener) === -1) listeners[type].push(listener)
  }

  removeEventListener(type, listener) {
    const listeners = this._listeners
    if (listeners === undefined) return
    const listenerArray = listeners[type]
    if (listenerArray !== undefined) {
      const index = listenerArray.indexOf(listener)
      if (index !== -1) listenerArray.splice(index, 1)
    }
  }

  dispatchEvent(event) {
    const listeners = this._listeners
    if (listeners === undefined) return
    const listenerArray = listeners[event.type]
    if (listenerArray !== undefined) {
      event.target = this
      const array = listenerArray.slice(0)
      for (let i = 0, l = array.length; i < l; i++) array[i].call(this, event)
      event.target = null
    }
  }

  count(type) {
    const listeners = this._listeners
    return listeners === undefined || listeners[type] === undefined ? 0 : listeners[type].length
  }
}

class CanvasTarget extends EventDispatcher {
  constructor() {
    super()
    this.width = 1
  }

  setSize(width) {
    this.width = width
    this.dispatchEvent({ type: 'resize' })
  }
}

class Renderer {
  constructor(canvasTarget) {
    this.label = 'renderer'
    this.resizes = 0
    this._onCanvasTargetResize = this._onCanvasTargetResize.bind(this)
    this._canvasTarget = canvasTarget
    this._canvasTarget.addEventListener('resize', this._onCanvasTargetResize)
  }

  _onCanvasTargetResize() {
    this.resizes++
    console.log('resize', this.label, this.resizes, this._canvasTarget.width)
  }

  setCanvasTarget(canvasTarget) {
    this._canvasTarget.removeEventListener('resize', this._onCanvasTargetResize)
    this._canvasTarget = canvasTarget
    this._canvasTarget.addEventListener('resize', this._onCanvasTargetResize)
  }

  poke() {
    this._onCanvasTargetResize()
  }
}

class Material {
  get opacity() {
    return 1
  }
}

/** @type {any} */
const materialPrototype = Material.prototype
const descriptors = Object.getOwnPropertyDescriptors(materialPrototype)
const listed = []
for (const key in descriptors) {
  if (key === 'constructor') continue
  listed.push(key + ':' + (descriptors[key].get !== undefined ? 'get' : 'value'))
}
console.log('descriptors', listed.join(','))

const first = new CanvasTarget()
const renderer = new Renderer(first)
first.setSize(640)
first.setSize(800)
renderer.poke()
renderer._onCanvasTargetResize()

const second = new CanvasTarget()
renderer.setCanvasTarget(second)
first.setSize(2)
second.setSize(1024)
console.log('listeners', first.count('resize') + 1, second.count('resize'))
