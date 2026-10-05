// @ts-nocheck
//! expect: layer 2 3
//! expect: keys 1
//! expect: method 10 function
//! emitted-has: gea::callableBindIsIntrinsic

// three's XRManager: `this._createXRLayer = createXRLayer.bind( this )`, where
// `createXRLayer` is a module function declaration reading `this`, in a
// program that also writes a computed key through an `any` box. The Function
// object is known, but the unboxed-method census covers only class methods,
// so nothing proves it unboxed: the builtin `bind` is taken behind the
// run-time own-`bind` check, not through `bind`'s lib.d.ts signature, whose
// result keeps the receiver and cannot fill the field's receiverless slot.
class Manager {
  constructor() {
    this._binding = { make: (o) => o.width }
    this.depth = 3
    /** @type {Function} */
    this._createLayer = createLayer.bind(this)
  }
  /** @param {Object} layer */
  use(layer) {
    layer.xrlayer = this._createLayer(layer)
    return layer.xrlayer
  }
}
function createLayer(layer) {
  return this._binding.make({ width: layer.width / 2 }) + ' ' + this.depth
}
// A class method whose Function object escapes through a plain read has its
// unboxed assumption refuted, so its bind takes the same guard.
class Holder {
  constructor(w) {
    this.w = w
  }
  area() {
    return this.w * 2
  }
}
class Owner {
  /** @param {Holder} h */
  constructor(h) {
    /** @type {Function} */
    this._area = h.area.bind(h)
  }
}
const holder = new Holder(5)
const escaped = holder.area
const box = JSON.parse('{}')
box[String(Math.random())] = 1
console.log('layer', new Manager().use({ width: 4 }))
console.log('keys', Object.keys(box).length)
console.log('method', new Owner(holder)._area(), typeof escaped)
