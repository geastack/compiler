// @ts-nocheck
//! expect: named uv vec2
//! expect: unnamed vec4
//! expect: ternary none sel
// three's `VertexColorNode` calls `super( null, 'vec4' )` into `AttributeNode(
// attributeName, nodeType = null )` under `@param {string} attributeName`. The
// tag leaves `null` out; a caller passes it, and the parameter holds it.
// `NodeBuilder.getTernary()` states `@return {string}` and returns `null` until
// a backend overrides it: the call's value is that `null`.
class AttributeNode {
  /**
   * @param {string} attributeName
   * @param {?string} [nodeType=null]
   */
  constructor(attributeName, nodeType = null) {
    this._attributeName = attributeName
    this.nodeType = nodeType
  }
  /** @return {string} */
  describe() {
    return (this._attributeName === null ? 'unnamed' : 'named ' + this._attributeName) + ' ' + this.nodeType
  }
}
class Builder {
  /** @return {string} */
  getTernary() {
    return null
  }
}
class WGSLBuilder extends Builder {
  /** @return {string} */
  getTernary() {
    return 'sel'
  }
}
/** @param {Builder} builder */
const ternaryOf = (builder) => {
  const snippet = builder.getTernary()
  return snippet === null ? 'none' : snippet
}
class VertexColorNode extends AttributeNode {
  constructor() {
    super(null, 'vec4')
  }
}
console.log(new AttributeNode('uv', 'vec2').describe())
console.log(new VertexColorNode().describe())
console.log('ternary ' + ternaryOf(new Builder()) + ' ' + ternaryOf(new WGSLBuilder()))
