//! expect: resize 1
//! expect: layer 2 base
//! expect: keys 1
//! emitted-has: gea::callableBindIsIntrinsic

// three's Renderer and XRManager: `this._onCanvasTargetResize =
// this._onCanvasTargetResize.bind( this )` rebinds a method into the field of
// the same name, so the read names no single Function object, and the program
// elsewhere writes a computed key through an `any` box. With no object to
// census, the builtin `bind` is taken behind the run-time own-`bind` check
// instead of `bind`'s lib.d.ts signature, whose result keeps the receiver and
// cannot fill the field's receiverless slot.

class Renderer {
  constructor() {
    this.n = 1
    /** @type {Function} */
    this._onResize = this._onResize.bind(this)
  }

  _onResize() {
    console.log('resize', this.n)
  }
}

class XRManager {
  constructor() {
    this.n = 2
    /** @type {Function} */
    this._createLayer = this._createLayer.bind(this)
  }

  /** @param {string} name */
  _createLayer(name) {
    console.log('layer', this.n, name)
  }
}

/** @type {any} */
const bag = JSON.parse('{}')
const key = 'k' + String(Math.floor(Math.random()))
bag[key] = 1

new Renderer()._onResize()
new XRManager()._createLayer('base')
console.log('keys', Object.keys(bag).length)
