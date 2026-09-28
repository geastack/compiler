// @ts-nocheck
// A bare `new Map()` whose writes are TYPED, but more loosely than the
// parameter it is passed to: `overrides` states its pairs as
// `Array<Array<Part|Function>>`, so each key is a `Part | Function`, while
// `@param {Map<Part, Function>}` states `Part` keys. Joined from its writes the
// map is keyed by the union, which the `Part`-keyed parameter can never take;
// it takes the statement instead and each key narrows into it at the write.
// A fresh `new Map( [ ... ] )` reaches the same parameter from a second
// caller (three's `overrideNodes` and `overrideNode` into
// `new OverrideContextNode( map )`).
class Part {
  /** @param {string} t - The tag. */
  constructor(t) {
    this.t = t
    this.isPart = true
  }
}
class Context extends Part {
  /**
   * @param {?Part} node - The flow node.
   * @param {Object} [value={}] - The context data.
   */
  constructor(node = null, value = {}) {
    super('ctx')
    this.node = node
    this.value = value
  }
}
class Override extends Context {
  /**
   * @param {Map<Part, Function>} overrides - The override callbacks.
   * @param {Part|null} [flow=null] - The flow node.
   */
  constructor(overrides, flow = null) {
    super(flow, {})
    this.overrides = overrides
    this.isOverride = true
  }
  /**
   * @param {Part} node - The node.
   * @return {string} The override's tag.
   */
  tagOf(node) {
    const callback = this.overrides.get(node)
    return callback === undefined || callback === null ? '-' : callback().t
  }
  /** @return {number} The override count. */
  count() {
    return this.overrides.size
  }
}
/**
 * @param {Array<Array<Part|Function>>} overrides - The override pairs.
 * @return {Override} The override.
 */
function overrideAll(overrides) {
  const map = new Map()
  for (const [node, value] of overrides) {
    const callback = typeof value === 'function' ? value : () => value
    map.set(node, callback)
  }
  return new Override(map)
}
/**
 * @param {Part} target - The overridden node.
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
const q = new Part('q')
/** @type {Array<Array<Part|Function>>} */
const pairs = [
  [p, new Part('r')],
  [q, () => p]
]
const o = overrideAll(pairs)
const one = overrideOne(q, new Part('s'))
const none = overrideOne(p)
console.log(o.tagOf(p), o.tagOf(q), o.tagOf(new Part('z')), o.count())
console.log(one.tagOf(q), one.tagOf(p), none.tagOf(p), none.count())
//! expect: r p - 2
//! expect: s - - 1
