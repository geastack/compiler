// @ts-nocheck
//! expect: 2 1
//! emitted-has: , double gea_arg_0)
//! emitted-lacks: gea::Value::box(gea::Value::Tag::Number
// A call runs an override only on a receiver whose class declares it or
// extends a class that does. `Right` inherits `Base.erase` and calls
// `this.erase( 'string' )`; a `Right` never runs `Left.erase`, a sibling's
// override, so the string is no evidence against `Left`'s `@param {number}`.
// The tag stands, and `value` is a native number. Read against every
// override of `Base.erase`, the string erased the tag, and the census of
// `erase`'s callers, left open by `callback.bind( this )`, refused the
// parameter. three's `Textures` calls its inherited `DataMap.has(
// renderTarget )` beside `Geometries.has`'s `@param {RenderObject}`.
class Base {
  /** @param {Object} value */
  erase(value) {
    return 1
  }
}
class Left extends Base {
  /** @param {number} value */
  erase(value) {
    return value + 1
  }
}
class Right extends Base {
  run() {
    return this.erase('string')
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.left = new Left()
    this.right = new Right()
  }
}
const holder = new Holder()
console.log(holder.left.erase(1) + ' ' + holder.right.run())
