// @ts-nocheck
// A bare `new Map()` filled only by untyped writes states nothing about its
// keys and values, so the checker lays it out as `Map<any, any>`, while the
// parameter it is passed to states `@param {Map<Part, Function>}`: one map,
// two carriers, and no conversion between keyed collections that keeps the
// map's identity. The map takes the statement and each write converts into
// it (three's `overrideNodes` into `new OverrideContextNode( map )`).
class Part {
  /** @param {string} t - The tag. */
  constructor(t) {
    this.t = t
    this.isNode = true
  }
}
class Override {
  /** @param {Map<Part, Function>} overrides - The override callbacks. */
  constructor(overrides) {
    this.overrides = overrides
  }
  /**
   * @param {Part} node - The node.
   * @return {string} The override's tag.
   */
  tagOf(node) {
    const callback = this.overrides.get(node)
    return callback === undefined ? '-' : callback().t
  }
  /** @return {number} The override count. */
  count() {
    return this.overrides.size
  }
}
function overrideAll(pairs) {
  const map = new Map()
  for (const [node, value] of pairs) {
    const callback = typeof value === 'function' ? value : () => value
    map.set(node, callback)
  }
  return new Override(map)
}
const p = new Part('p')
const q = new Part('q')
// Reached by a computed key, as three reaches it through its node proxy, so
// no call site types `pairs`.
const chain = {}
chain['overrideAll'] = (pairs) => overrideAll(pairs)
const o = chain[String('overrideAll')]([
  [p, new Part('r')],
  [q, () => p]
])
console.log(o.tagOf(p), o.tagOf(q), o.tagOf(new Part('z')), o.count())
//! expect: r p - 2
