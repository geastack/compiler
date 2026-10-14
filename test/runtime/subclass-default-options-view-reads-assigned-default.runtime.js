//! expect: cube=300,1,-
//! expect: plain=301,2,-
//! expect: wrapped=-,1,1001
//! expect: empty=-,1,-
// three's RenderTarget hands its constructor options to
// `_setTextureOptions( options = {} )`, whose JSDoc states a narrower record
// than the constructor's, and reads each key with `options.mapping !==
// undefined`. WebGLCubeRenderTarget forwards its own `options = {}` default
// through `super( size, size, options )` and again to `_setTextureOptions`,
// so the object the method reads is a live view of a literal with none of the
// keys: every read must answer the key's absence through the view, never
// assume the slot the method's own default literal carries.

/**
 * @typedef {Object} TargetOptions
 * @property {number} [mapping]
 * @property {number} [wrapS]
 * @property {number} [depth]
 * @property {number} [count]
 */

class Texture {
  constructor() {
    this.mapping = -1
    this.wrapS = -1
  }
}

class RenderTargetLike {
  /** @param {TargetOptions} [options] */
  constructor(width = 1, height = 1, options = {}) {
    options = Object.assign({ depth: 1, count: 1 }, options)
    this.depth = options.depth
    this.width = width
    this.texture = new Texture()
    this._setTextureOptions(options)
  }

  /** @param {{mapping?: number, wrapS?: number}} [options] */
  _setTextureOptions(options = {}) {
    const values = { minFilter: 1006 }
    if (options.mapping !== undefined) values.mapping = options.mapping
    if (options.wrapS !== undefined) values.wrapS = options.wrapS
    if (values.mapping !== undefined) this.texture.mapping = values.mapping
    if (values.wrapS !== undefined) this.texture.wrapS = values.wrapS
  }
}

class CubeTargetLike extends RenderTargetLike {
  /** @param {TargetOptions} [options] */
  constructor(size = 1, options = {}) {
    super(size, size, options)
    this._setTextureOptions(options)
  }
}

const show = (target) =>
  (target.texture.mapping < 0 ? '-' : target.texture.mapping) + ',' + target.depth + ',' + (target.texture.wrapS < 0 ? '-' : target.texture.wrapS)
const cube = new CubeTargetLike(128, { mapping: 300 })
console.log('cube=' + show(cube))
console.log('plain=' + show(new RenderTargetLike(1, 1, { mapping: 301, depth: 2 })))
console.log('wrapped=' + show(new CubeTargetLike(4, { wrapS: 1001 })))
console.log('empty=' + show(new CubeTargetLike(8)))
