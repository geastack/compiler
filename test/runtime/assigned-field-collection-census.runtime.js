// @ts-nocheck
// A JavaScript class declares a field by assigning it. three's
// `NodeBuilder.flowsData = new WeakMap()` is keyed by a JSDoc-typed `Node`
// parameter: the census typed the allocation and every read of the field from
// that key, while the field itself kept `WeakMap`'s defaulted `object` key, so
// the one storage had two carriers and the store between them refused.
class Key {
  constructor(id) {
    this.id = id
  }
}

class Builder {
  constructor() {
    this.flowsData = new WeakMap()
  }

  /**
   * @param {Key} node - The key.
   * @return {Object} The flow data.
   */
  getFlowData(node) {
    return this.flowsData.get(node)
  }

  /**
   * @param {Key} node - The key.
   * @return {Object} The flow data.
   */
  flowNode(node) {
    const flowData = { code: 'k' + node.id }
    this.flowsData.set(node, flowData)
    return flowData
  }
}

const builder = new Builder()
const first = new Key(1)
const second = new Key(2)
builder.flowNode(first)
builder.flowNode(second)
console.log(builder.getFlowData(first).code, builder.getFlowData(second).code, builder.flowsData.has(new Key(3)))
//! expect: k1 k2 false
