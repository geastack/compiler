// @ts-nocheck
//! expect: 2,true,p,true,true,true,function,p>p,q>p,pq,2,2,3,true,false,2,true
//! expect: 3
//
// A Map stored in an object literal handed to an `@param {Object}` slot is read
// back through that dynamic value: `this.value.overrides.size`, `.get`, `.has`,
// iteration, `forEach`, `set` and `delete`. The Map is the same object the
// caller built -- read and written in place through its box's keyed-collection
// operations, never copied -- so every answer matches node's.
// (The three.js shape: `ContextNode` / `OverrideContextNode.getFlowContextData`.)
class Part {
  /** @param {string} t - The tag. */
  constructor(t) {
    this.t = t
  }
}
class Context {
  /** @param {Object} [value={}] - The context data. */
  constructor(value = {}) {
    this.value = value
  }
}
class Override extends Context {
  /** @param {Map<Part, Function>} overrides - The override callbacks. */
  constructor(overrides) {
    super({ overrides })
    this.isOverride = true
  }
  /** @return {string} What the dynamic Map answers. */
  report(probe) {
    const m = this.value.overrides
    const out = []
    out.push(m.size)
    out.push(m.has(probe))
    out.push(m.get(probe)().t)
    out.push(m.get(new Part('x')) === undefined)
    out.push(m.get('nope') === undefined)
    out.push(m[Symbol.iterator] === m.entries)
    out.push(typeof m.get)
    for (const [k, v] of m) out.push(k.t + '>' + v().t)
    let ks = ''
    for (const k of m.keys()) ks += k.t
    out.push(ks)
    let vs = 0
    for (const v of m.values()) vs += typeof v === 'function' ? 1 : 0
    out.push(vs)
    let seen = 0
    m.forEach((v, k, self) => {
      seen += self === m && typeof v === 'function' && k instanceof Part ? 1 : 0
    })
    out.push(seen)
    const extra = new Part('e')
    m.set(extra, () => extra)
    out.push(m.size)
    out.push(m.delete(extra))
    out.push(m.delete(extra))
    out.push(m.size)
    out.push(m.notAMember === undefined)
    return out.join(',')
  }
}
/**
 * @param {Array<Override>} nodes - The nodes.
 * @return {number} The merged size.
 */
function merged(nodes) {
  const children = []
  for (const node of nodes) children.push(node.value.overrides)
  const all = new Map()
  for (const map of children) for (const [k, v] of map.entries()) all.set(k, v)
  return all.size
}
const p = new Part('p')
const q = new Part('q')
const a = new Override(new Map([[p, () => p], [q, () => p]]))
const b = new Override(new Map([[new Part('r'), () => q]]))
console.log(a.report(p))
console.log(merged([a, b]))
