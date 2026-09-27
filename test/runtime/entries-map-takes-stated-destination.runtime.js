// @ts-nocheck
// `new Map( [[ k, v ]] )` is a fresh map built from a literal of entries. The
// checker infers its arguments from the entries, while the parameter it is
// passed to states `@param {Map<Part, Function>}`: one map, two carriers,
// and no conversion between keyed collections that keeps the map's
// identity. The map takes the statement and each entry converts into it
// where the map is built (three's `overrideNode` into
// `new OverrideContextNode( new Map( [[ targetNode, callback ]] ) )`).
class Part {
  /** @param {string} t - The tag. */
  constructor(t) {
    this.t = t
    this.isPart = true
  }
}
class Override {
  /** @param {Map<Part, Function>} overrides - The override callbacks. */
  constructor(overrides) {
    this.overrides = overrides
  }
  /**
   * @param {Part} part - The part.
   * @return {string} The override's tag.
   */
  tagOf(part) {
    const callback = this.overrides.get(part)
    return callback === undefined || callback === null ? '-' : callback().t
  }
}
/**
 * @param {Part} target - The part to override.
 * @param {Function|Part|null} [callback=null] - The override.
 * @return {Override} The override.
 */
function overrideOne(target, callback = null) {
  if (callback && callback.isPart) {
    const part = callback
    callback = () => part
  }
  return new Override(new Map([[target, callback]]))
}
const p = new Part('p')
const a = overrideOne(p, () => new Part('q'))
const b = overrideOne(p, new Part('r'))
const c = overrideOne(p)
console.log(a.tagOf(p), b.tagOf(p), c.tagOf(p), a.tagOf(new Part('z')), a.overrides.size)
//! expect: q r - - 1
