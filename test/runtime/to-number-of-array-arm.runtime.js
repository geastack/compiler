// @ts-nocheck
//! expect: nodeVar0 nodeVar1 nodeConst0 2 [object Object],[object Object]
// three's `NodeBuilder.getVarFromNode` (`nodes/core/NodeBuilder.js`): one
// dictionary, stated `Object<string,Array<NodeVar>|number>`, holds each
// stage's variables and the per-kind counters, and `this.vars[ idNS ] ++`
// takes ToNumeric of that sum. The number arm is itself; an Array arm is
// ToNumber of its join, which for elements that are plain objects is
// "[object Object]" each. (The stage list is cast to its array arm here only
// because a method call on the whole sum is a separate, unrendered case.)
class NodeVar {
  constructor(name) {
    this.name = name
  }
}
class NodeBuilder {
  constructor() {
    /** @type {Object<string,Array<NodeVar>|number>} */
    this.vars = {}
  }
  getVar(shaderStage, readOnly) {
    const idNS = readOnly ? '_const' : '_var'
    const vars = /** @type {Array<NodeVar>} */ (this.vars[shaderStage] || (this.vars[shaderStage] = []))
    const id = this.vars[idNS] || (this.vars[idNS] = 0)
    const name = (readOnly ? 'nodeConst' : 'nodeVar') + id
    this.vars[idNS]++
    vars.push(new NodeVar(name))
    return name
  }
}
const builder = new NodeBuilder()
const names = [builder.getVar('vertex', false), builder.getVar('vertex', false), builder.getVar('fragment', true)]
const nodes = [new NodeVar('a'), new NodeVar('b')]
console.log(names.join(' '), builder.vars.vertex.length, `${nodes}`)
