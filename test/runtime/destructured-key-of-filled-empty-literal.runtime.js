// @ts-nocheck
//! expect: x = 1;y = 2

// A destructured key of an empty literal the program fills later.
//
// three's `NodeBuilder.getDataFromNode( node )` returns a `{}` created once per
// node, and its callers write members onto it through the returned alias:
// `nodeData.flowCodes || ( nodeData.flowCodes = [] )` in
// `addLineFlowCodeBlock`. `addFlowCodeHierarchy` then reads the key back with
// `const { flowCodes, flowCodeBlock } = this.getDataFromNode( node )` and
// iterates it. The pattern census read `flowCodes` as `undefined` -- a key the
// holder's `{}` type declares no member for -- and the for-of over it refused
// as "the source declares no @@iterator chain". An empty literal is closed only
// if no write anywhere can add the key, which is the proof a member read off a
// closed literal already passes (`closedLiteralMemberAbsent`); here the write
// through the alias fails it, so the key stays unstated and the loop walks it
// through the dynamic protocol.
class Builder {
  constructor() {
    /** @type {Map<string, Object>} */
    this.nodesData = new Map()
    this.lines = []
  }
  /**
   * @param {string} key
   * @return {Object}
   */
  getDataFromNode(key) {
    let nodeData = this.nodesData.get(key)
    if (nodeData === undefined) {
      nodeData = {}
      this.nodesData.set(key, nodeData)
    }
    return nodeData
  }
  addFlowCodeHierarchy(key) {
    const { flowCodes } = this.getDataFromNode(key)
    for (const flowCode of flowCodes) this.lines.push(flowCode)
  }
  addLineFlowCodeBlock(key, code) {
    const nodeData = this.getDataFromNode(key)
    const flowCodes = nodeData.flowCodes || (nodeData.flowCodes = [])
    flowCodes.push(code)
  }
}
const b = new Builder()
b.addLineFlowCodeBlock('n', 'x = 1')
b.addLineFlowCodeBlock('n', 'y = 2')
b.addFlowCodeHierarchy('n')
console.log(b.lines.join(';'))
