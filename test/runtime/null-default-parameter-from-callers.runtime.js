// @ts-nocheck
//! expect: groups frame object none 0 none
//! expect: convert float1! vec22
//! expect: plain a b-frame
// three's `uniformGroup = ( name, order = 1, updateType = null ) => ...` and
// `ConvertType = function ( type, cacheMap = null )`: a parameter typed only
// by a `null` default, whose callers pass a value. The checker
// types it `null`; the callers are the evidence, so the ABI slot and the
// body's own binding and reads agree on what they pass.
const NodeUpdateType = { NONE: 'none', FRAME: 'frame', RENDER: 'render', OBJECT: 'object' }
class UniformGroupNode {
  /**
   * @param {string} name
   * @param {boolean} [shared=false]
   * @param {number} [order=1]
   * @param {?string} [updateType=null]
   */
  constructor(name, shared = false, order = 1, updateType = null) {
    this.name = name
    this.shared = shared
    this.order = order
    this.updateType = updateType === null ? 'none' : updateType
  }
}
/** @param {string} name @returns {UniformGroupNode} */
const uniformGroup = (name, order = 1, updateType = null) => new UniformGroupNode(name, false, order, updateType)
/** @param {string} name @param {number} [order=0] @returns {UniformGroupNode} */
const sharedUniformGroup = (name, order = 0, updateType = null) => new UniformGroupNode(name, true, order, updateType)
const frameGroup = sharedUniformGroup('frame', 0, NodeUpdateType.FRAME)
const objectGroup = uniformGroup('object', 1, NodeUpdateType.OBJECT)
const plainGroup = uniformGroup('plain')
const late = sharedUniformGroup('late')
console.log('groups', frameGroup.updateType, objectGroup.updateType, plainGroup.updateType, late.order, late.updateType)

const ConvertType = function (type, suffix = null) {
  return (value) => (suffix !== null ? `${type}${value}${suffix}` : `${type}${value}`)
}
const float = new ConvertType('float', '!')
const vec2 = new ConvertType('vec2')
console.log('convert', float(1), vec2(2))

function join(name, suffix = null) {
  return suffix === null ? name : name + '-' + suffix
}
console.log('plain', join('a'), join('b', 'frame'))
