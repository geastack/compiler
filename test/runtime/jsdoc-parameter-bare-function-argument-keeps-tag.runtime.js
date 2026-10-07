// @ts-nocheck
//! expect: 3,2,1 1,2,3
//! emitted-has: gea::Optional<gea::CallableObject<double(gea::Value, gea::Value)>> gea_arg_1
// Bare `Function` states no calling convention, so a value typed by it is no
// evidence against a tag that states one. `Renderer` passes its `@type
// {?Function}` field to `RenderList.sort( items, customSort )` under `@param
// {?function(any, any): number}`; the checker calls `Function` assignable to
// no such signature, and that erased the comparator's tag, after which the
// census of `sort`'s callers, left open by `callback.bind( this )`, refused
// the parameter. The tag stands. three's `Renderer` passes its `_opaqueSort`
// and `_transparentSort` fields to `RenderList.sort` the same way.
class RenderList {
  /** @param {Array<number>} items @param {?function(any, any): number} customSort */
  sort(items, customSort) {
    if (customSort !== null) items.sort(customSort)
    return items.join(',')
  }
}
class Renderer {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    /** @type {?Function} */
    this._sort = null
    this.list = new RenderList()
  }
  /** @param {Array<number>} items */
  render(items) {
    return this.list.sort(items, this._sort)
  }
}
const renderer = new Renderer()
const first = renderer.render([3, 2, 1])
renderer._sort = (left, right) => left - right
console.log(first + ' ' + renderer.render([3, 2, 1]))
