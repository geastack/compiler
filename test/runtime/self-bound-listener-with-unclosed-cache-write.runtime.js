// @ts-nocheck
//! expect: resize renderer 1 640
//! expect: resize renderer 2 800
//! expect: resize renderer 3 800
//! expect: resize renderer 4 800
//! emitted-lacks: gea::refuseSelfBoundPrototypeRead
//! emitted-has: ::adaptSource(gea::CallableObject<void()>
//! emitted-lacks: gea::CallableObject<void()> _onCanvasTargetResize;

// three's Renderer self-binds `_onCanvasTargetResize` and its CanvasTarget
// calls it as `listener.call(this, event)`. A computed-key store elsewhere in
// the program (three's `InterleavedBufferAttribute.clone`) keeps the self-bind
// proof from closing, so the read hands the receiver-taking slot to the
// dispatcher: the bound function behind an adapter that ignores its receiver.
// A boxed call must not convert the CanvasTarget it passes as `this` into the
// Renderer the slot's receiver formal names; the adapter never reads it.

export {}

class EventDispatcher {
  addEventListener(type, listener) {
    if (this._listeners === undefined) this._listeners = {}
    const listeners = this._listeners
    if (listeners[type] === undefined) listeners[type] = []
    if (listeners[type].indexOf(listener) === -1) listeners[type].push(listener)
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
    this._canvasTarget = canvasTarget
    this._onCanvasTargetResize = this._onCanvasTargetResize.bind(this)
    canvasTarget.addEventListener('resize', this._onCanvasTargetResize)
  }

  _onCanvasTargetResize() {
    this.resizes++
    console.log('resize', this.label, this.resizes, this._canvasTarget.width)
  }

  poke() {
    this._onCanvasTargetResize()
  }
}

const canvasTarget = new CanvasTarget()
const renderer = new Renderer(canvasTarget)
canvasTarget.setSize(640)
canvasTarget.setSize(800)
renderer.poke()
renderer._onCanvasTargetResize()

// Like InterleavedBufferAttribute.clone: an Object bag receives a computed-key call result.
/** @param {Object} data @param {string} key */
function cacheClone(data, key) {
  if (data.interleavedBuffers === undefined) data.interleavedBuffers = {}
  data.interleavedBuffers[key] = makeClone()
}
function makeClone() {
  return { width: 1 }
}
if (canvasTarget.width === 1) cacheClone({}, 'buffer')
