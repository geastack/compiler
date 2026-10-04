// @ts-nocheck
//! expect: clone 2 3
//! expect: handler load
//! expect: name box
// A store through a computed key whose spelling cannot be `copy` -- the
// `'on' + type` an event shim writes onto whatever target it is handed --
// replaces no member of the geometry family, so `clone()`'s
// `new this.constructor().copy( this )` still has its overriding targets.
class Geometry {
  constructor() {
    this.attrs = { count: 0 }
  }
  /** @param {Geometry} source */
  copy(source) {
    this.attrs = { count: source.attrs.count }
    return this
  }
  clone() {
    return new this.constructor().copy(this)
  }
}
class Box extends Geometry {
  constructor() {
    super()
    this.size = 1
  }
  /** @param {Box} source */
  copy(source) {
    super.copy(source)
    this.size = source.size
    return this
  }
}
/**
 * @param {any} target
 * @param {string} type
 */
function listen(target, type) {
  target['on' + type] = () => type
}
/**
 * @param {any} target
 * @param {string} name
 */
function label(target, name) {
  target[`${name}Name`] = name
}
const box = new Box()
box.size = 2
box.attrs.count = 3
listen(box, 'load')
label(box, 'box')
const copy = box.clone()
console.log('clone', copy.size, copy.attrs.count)
console.log('handler', box.onload())
console.log('name', box.boxName)
export {}
