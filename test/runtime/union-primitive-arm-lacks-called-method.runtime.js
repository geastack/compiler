// @ts-nocheck
//! expect: ensure 1 2 2
//! expect: number-arm TypeError
// three's NodeBuilder keeps `this.vars` as `Object<string,Array<NodeVar>|number>`
// (per-stage variable lists beside per-kind counters), and WGSLNodeBuilder
// calls `vars.includes( varying )` on one entry. The number arm's intact
// Number.prototype chain declares no `includes`, so the read answers
// `undefined` there (10.1.8.1) and the call throws a TypeError (7.3.14 Call);
// the call's value is the array arm's boolean.
class NodeVar {
  /** @param {string} name */
  constructor(name) {
    this.name = name
  }
}
class Builder {
  constructor() {
    /** @type {Object<string,Array<NodeVar>|number>} */
    this.vars = {}
  }
  /** @param {string} stage @param {string} name */
  getVar(stage, name) {
    const vars = this.vars[stage] || (this.vars[stage] = [])
    const v = new NodeVar(name)
    vars.push(v)
    return v
  }
  /** @param {string} stage @param {number} count */
  count(stage, count) {
    this.vars[stage] = count
  }
  /** @param {string} stage @param {NodeVar} v */
  ensure(stage, v) {
    const vars = this.vars[stage]
    if (vars.includes(v) === false) vars.push(v)
    return vars.length
  }
}
const b = new Builder()
const a = b.getVar('vertex', 'a')
const other = new NodeVar('o')
console.log('ensure', b.ensure('vertex', a), b.ensure('vertex', other), b.ensure('vertex', other))
b.count('_var', 3)
try {
  b.ensure('_var', a)
  console.log('number-arm no-throw')
} catch (error) {
  console.log('number-arm', error instanceof TypeError ? 'TypeError' : 'other')
}
