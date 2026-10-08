// @ts-nocheck
//! expect: resize renderer 1 resize 640
//! expect: resize renderer 2 resize 800
//! expect: resize renderer 3 poke 800
//! expect: resize renderer 4 direct 800
//! emitted-lacks: gea::refuseSelfBoundPrototypeRead
//! emitted-has: ::adaptSourcePastReceiver(

// The self-bound listener of `self-bound-listener-with-unclosed-cache-write`,
// keeping its event parameter. The adapter ignores the receiver its slot
// passes and forwards the event, so a boxed call with the CanvasTarget as
// `this` binds the receiver formal empty and converts only the event.

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

  _onCanvasTargetResize(event) {
    this.resizes++
    console.log('resize', this.label, this.resizes, event.type, this._canvasTarget.width)
  }

  poke() {
    this._onCanvasTargetResize({ type: 'poke' })
  }
}

const canvasTarget = new CanvasTarget()
const renderer = new Renderer(canvasTarget)
canvasTarget.setSize(640)
canvasTarget.setSize(800)
renderer.poke()
renderer._onCanvasTargetResize({ type: 'direct' })

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
