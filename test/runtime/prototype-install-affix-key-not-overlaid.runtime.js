// @ts-nocheck
//! expect: texture true true
//! expect: flip y vec2
//! expect: background y uv
//! expect: flags true false
// three's `Texture` and `Node` both extend `EventDispatcher`. `Texture` sets
// `this.flipY = true`; TSLCore installs `flipY()` on `Node.prototype` under
// the computed key `'flip' + propUpper`. The subclass-member overlay must not
// state on `EventDispatcher` that `flipY` is the texture flag or `undefined`:
// a key that starts with 'flip' can be `flipY`, and a `Node` finds the
// installed method there. `TextureNode.setupUV` calls it through a `Node`
// parameter, `NodeManager.updateBackground` through `screenUV`, which the
// checker types `any`. `isTexture`, which no install can name, keeps its
// overlay for a base-typed read.
import { EventDispatcher } from './_flip-install-dispatcher.js'
import { Texture } from './_flip-install-texture.js'
import Node from './_flip-install-node.js'
import TextureNode, { texture, screenUV } from './_flip-install-texture-node.js'

class NodeManager {
  constructor() {
    this.cache = new Map()
  }

  /**
   * @param {string} type
   * @param {Object} object
   * @param {Function} callback
   * @return {Node}
   */
  getCacheNode(type, object, callback) {
    let node = this.cache.get(object)
    if (node === undefined) {
      node = callback()
      this.cache.set(object, node)
    }
    return node
  }

  /**
   * @param {{ background: Texture }} scene
   */
  updateBackground(scene) {
    const background = scene.background
    const backgroundNode = this.getCacheNode('background', background, () => {
      if (background.isTexture === true) {
        return texture(background, screenUV.flipY())
      }
      return null
    })
    return backgroundNode
  }
}

/** @param {EventDispatcher} target */
function isTexture(target) {
  return target.isTexture === true
}

const tex = new Texture()
console.log('texture', tex.flipY, tex.isTexture)

const source = new Node('vec2')
const flipped = new TextureNode(tex).setupUV({ isFlipY: () => true }, source)
console.log('flip', flipped.components, flipped.sourceNode.nodeType)

const background = new NodeManager().updateBackground({ background: tex })
console.log('background', background.uvNode.components, background.uvNode.sourceNode.scope)

console.log('flags', isTexture(tex), isTexture(source))
