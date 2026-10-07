// @ts-nocheck
//! expect: resize renderer 1 640
//! expect: resize original 2 640
//! expect: resize renderer 3 800
//! expect: same false
//! emitted-lacks: gea::refuseSelfBoundPrototypeRead

// A program that reads the original method off the class prototype
// (`Renderer.prototype._onResize`) hands that prototype's slot to code the
// self-bind proof does not follow, so the proof refuses and every read of the
// slot keeps the method's convention, which takes a receiver. The original
// still uses the receiver `.call` gives it, and the bound value in the
// instance's slot is a different function.
//
// Not covered: the bound slot handed to code that calls it with another
// receiver or with none (`listener.call(target, w)`, `listener(w)`). With the
// proof refused, that call is refused at run time, never answered with the
// wrong `this`.

export {}

class Renderer {
  constructor() {
    this.label = 'renderer'
    this.resizes = 0
    this._onResize = this._onResize.bind(this)
  }

  _onResize(width) {
    this.resizes++
    console.log('resize', this.label, this.resizes, width)
  }

  poke(width) {
    this._onResize(width)
  }
}

const renderer = new Renderer()
renderer.poke(640)

const original = Renderer.prototype._onResize
renderer.label = 'original'
original.call(renderer, 640)
renderer.label = 'renderer'
renderer._onResize(800)
console.log('same', original === renderer._onResize)
