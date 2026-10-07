// @ts-nocheck
//! expect: resize renderer 1 640
//! expect: resize renderer 2 800
//! expect: resize renderer 3 800
//! expect: resize renderer 4 800
//! emitted-has: gea::CallableObject<void()> _onCanvasTargetResize;

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
