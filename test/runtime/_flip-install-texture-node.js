// @ts-nocheck
import Node from './_flip-install-node.js'
import { nodeImmutable } from './_flip-install-tsl.js'

class ScreenNode extends Node {
  /**
   * @param {string} scope
   */
  constructor(scope) {
    super()
    this.scope = scope
  }
}

ScreenNode.UV = 'uv'

export const screenUV = /*@__PURE__*/ nodeImmutable(ScreenNode, ScreenNode.UV)

class TextureNode extends Node {
  /**
   * @param {?Object} value
   * @param {?Node} uvNode
   */
  constructor(value, uvNode = null) {
    super('vec4')
    this.value = value
    this.uvNode = uvNode
    this.sampler = true
  }

  /**
   * Setups the uv node.
   *
   * @param {{ isFlipY: () => boolean }} builder - The current node builder.
   * @param {Node} uvNode - The uv node to setup.
   * @return {Node} The updated uv node.
   */
  setupUV(builder, uvNode) {
    if (builder.isFlipY()) {
      uvNode = uvNode.toVar()

      if (this.sampler) {
        uvNode = uvNode.flipY()
      }
    }

    return uvNode
  }
}

export const texture = (value, uvNode = null) => new TextureNode(value, uvNode)

export default TextureNode
