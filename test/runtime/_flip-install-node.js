// @ts-nocheck
import { EventDispatcher } from './_flip-install-dispatcher.js'

class Node extends EventDispatcher {
  /**
   * @param {?string} nodeType
   */
  constructor(nodeType = null) {
    super()
    this.nodeType = nodeType
    /**
     * @type {boolean}
     * @readonly
     * @default true
     */
    this.isNode = true
  }
}

export default Node
