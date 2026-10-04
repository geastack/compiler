// @ts-nocheck
import { EventDispatcher } from './_flip-install-dispatcher.js'

class Texture extends EventDispatcher {
  constructor() {
    super()
    /**
     * @type {boolean}
     * @readonly
     * @default true
     */
    this.isTexture = true
    /**
     * If set to `true`, the texture is flipped along the vertical axis.
     *
     * @type {boolean}
     * @default true
     */
    this.flipY = true
  }
}

export { Texture }
