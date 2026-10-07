// @ts-nocheck
//! expect-refusal: the @param type of parameter "customSort" of sort was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// Bare `Function` is no evidence against a callable tag, but a callable with
// a signature the tag does not admit is: the `?function(string): string`
// field returns a string where `@param {?function(any, any): number}` states
// a number. The tag is erased, and with the census of `sort`'s callers left
// open by `callback.bind( this )`, the parameter cannot be typed from its
// complete callers; as a dynamic parameter it would box the callable passed
// to it. It is refused by name.
class RenderList {
  /** @param {Array<string>} items @param {?function(any, any): number} customSort */
  sort(items, customSort) {
    if (customSort !== null) items.sort(customSort)
    return items.join(',')
  }
}
class Renderer {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    /** @type {?function(string): string} */
    this._sort = (text) => text + '!'
    this.list = new RenderList()
  }
  /** @param {Array<string>} items */
  render(items) {
    return this.list.sort(items, this._sort)
  }
}
console.log(new Renderer().render(['b', 'a']))
