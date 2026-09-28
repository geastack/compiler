// @ts-nocheck
//! expect-refusal: an Array nested in a dynamically recovered Array
//
// A dynamic call (`chain[String(name)](...)`) hands a nested array literal to a
// parameter stated `Array<Array<Part|Function>>`. The literal's inner arrays are
// carried as one union and the parameter's as another, so the inner Array has
// no recovery that keeps its identity: an exact-carrier unbox aborts, and a
// rebuild would hand the callee a copy whose writes the caller never sees.
// Certification refuses by name instead of certifying a program that aborts.
// (The three.js shape: `addMethodChaining('overrideNodes', ...)`.)
class Part {
  /** @param {string} t - The tag. */
  constructor(t) {
    this.t = t
    this.isPart = true
  }
}
/**
 * @param {Array<Array<Part|Function>>} overrides - The override pairs.
 * @return {number} The count.
 */
function countAll(overrides) {
  let n = 0
  for (const [node, value] of overrides) {
    const callback = typeof value === 'function' ? value : () => value
    if (node.isPart && callback().t !== undefined) n++
  }
  return n
}
const p = new Part('p')
const q = new Part('q')
const chain = {}
chain['countAll'] = (overrides) => countAll(overrides)
console.log(chain[String('countAll')]([[p, new Part('r')], [q, () => p]]))
