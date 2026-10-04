// @ts-nocheck
import Node from './_flip-install-node.js'

class FlipNode extends Node {
  /**
   * @param {Node} sourceNode - The node which values should be flipped.
   * @param {string} components - The components that should be flipped.
   */
  constructor(sourceNode, components) {
    super()
    this.sourceNode = sourceNode
    this.components = components
  }
}

export default FlipNode
