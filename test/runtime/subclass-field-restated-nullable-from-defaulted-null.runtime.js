// @ts-nocheck
//! expect: fr frame
//! expect: ci null
//! expect: ob object
//! expect: on none
// three's `UniformGroupNode` (`nodes/core/UniformGroupNode.js`), reduced. `Node`
// declares `updateType` as `@type {string}`; the subclass restates it as
// `@type {string|null}` and writes its `updateType = null` parameter into it,
// and `sharedUniformGroup( 'cameraIndex' )` (`nodes/accessors/Camera.js`)
// leaves that parameter at its null default. JavaScript stores the null; the
// field must hold it rather than raise on the absent value.
export {}
const NodeUpdateType = { NONE: 'none', FRAME: 'frame', OBJECT: 'object' }
class BaseNode {
  constructor(nodeType = null) {
    /** @type {?string} */
    this.nodeType = nodeType
    /** @type {string} */
    this.updateType = NodeUpdateType.NONE
  }
  getUpdateType() {
    return this.updateType
  }
}
class UniformGroupNode extends BaseNode {
  constructor(name, shared = false, order = 1, updateType = null) {
    super('string')
    /** @type {string} */
    this.name = name
    /** @type {boolean} */
    this.shared = shared
    /** @type {number} */
    this.order = order
    /** @type {string|null} */
    this.updateType = updateType
  }
}
class PlainNode extends BaseNode {}
const uniformGroup = (name, order = 1, updateType = null) => new UniformGroupNode(name, false, order, updateType)
const sharedUniformGroup = (name, order = 0, updateType = null) => new UniformGroupNode(name, true, order, updateType)
const frameGroup = sharedUniformGroup('frame', 0, NodeUpdateType.FRAME)
const cameraIndexGroup = sharedUniformGroup('cameraIndex')
const objectGroup = uniformGroup('object', 1, NodeUpdateType.OBJECT)
const plain = new PlainNode('float')
console.log('fr', frameGroup.getUpdateType())
console.log('ci', cameraIndexGroup.getUpdateType())
console.log('ob', objectGroup.updateType)
console.log('on', plain.getUpdateType())
