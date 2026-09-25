// @ts-nocheck
// The class half of `prototype-install-runtime-key.runtime.js`: three's
// `Node`, its `EventDispatcher` base, and two subclasses, one of which
// declares a method a later install also names on the base.
export class ExtDispatcher {
  addListener(type) {
    this._listener = type
  }
}
export class ExtNode extends ExtDispatcher {
  constructor(nodeType) {
    super()
    this.nodeType = nodeType
  }
  getNodeType() {
    return this.nodeType
  }
}
export class ExtOperatorNode extends ExtNode {
  constructor(op, aNode, bNode) {
    super('float')
    this.op = op
    this.aNode = aNode
    this.bNode = bNode
  }
}
export class ExtMemberNode extends ExtNode {
  get(name) {
    return 'declared:' + name
  }
}
