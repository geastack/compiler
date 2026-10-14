//! expect: plain=4,true,1016,false,
//! expect: cube=1,true,1009,false,
//! expect: probes=8,false,1016,false,;16,false,1016,false,
//! expect: named=2,true,1009,false,R16F
// A render target's texture options are read through a view over the
// caller's own options object: `_setTextureOptions(options)` asks
// `options.internalFormat !== undefined` of an options literal that never
// named `internalFormat` (three's WebGLCubeRenderTarget, built per probe in
// a callback). The field's carrier is `string | null | undefined`, and an
// own field the literal does not have reads `undefined` -- not a missing
// source field.
const LinearFilter = 1006
const HalfFloatType = 1016
const UnsignedByteType = 1009

class Texture {
  constructor() {
    this.minFilter = LinearFilter
    this.magFilter = LinearFilter
    this.generateMipmaps = true
    /** @type {?string} */
    this.internalFormat = null
    this.type = UnsignedByteType
  }
}

class RenderTarget {
  /**
   * @typedef {Object} RenderTarget~Options
   * @property {boolean} [generateMipmaps=false]
   * @property {number} [magFilter=LinearFilter]
   * @property {number} [minFilter=LinearFilter]
   * @property {number} [type=UnsignedByteType]
   * @property {?string} [internalFormat=null]
   * @property {boolean} [depthBuffer=true]
   * @property {number} [count=1]
   */
  /**
   * @param {number} [width=1]
   * @param {number} [height=1]
   * @param {RenderTarget~Options} [options]
   */
  constructor(width = 1, height = 1, options = {}) {
    options = Object.assign({ generateMipmaps: false, internalFormat: null, minFilter: LinearFilter, magFilter: LinearFilter, type: UnsignedByteType, depthBuffer: true, count: 1 }, options)
    this.width = width
    this.height = height
    /** @type {Array<Texture>} */
    this.textures = []
    for (let i = 0; i < /** @type {number} */ (options.count); i++) this.textures.push(new Texture())
    this._setTextureOptions(options)
    this.depthBuffer = options.depthBuffer
  }
  get texture() {
    return /** @type {Texture} */ (this.textures[0])
  }
  /** @param {Texture} value */
  set texture(value) {
    this.textures[0] = value
  }
  /**
   * @param {{mapping?: number, wrapR?: number, magFilter?: number, minFilter?: number, type?: number, flipY?: boolean, generateMipmaps?: boolean, internalFormat?: ?string}} [options]
   */
  _setTextureOptions(options = {}) {
    const values = { minFilter: LinearFilter, generateMipmaps: false, internalFormat: /** @type {?string} */ (null) }
    /** @type {number | undefined} */
    let magFilter
    /** @type {number | undefined} */
    let type
    /** @type {number | undefined} */
    let mapping
    if (options.mapping !== undefined) mapping = options.mapping
    if (options.wrapR !== undefined) mapping = options.wrapR
    if (options.flipY !== undefined) values.generateMipmaps = options.flipY
    if (options.magFilter !== undefined) magFilter = options.magFilter
    if (options.minFilter !== undefined) values.minFilter = options.minFilter
    if (options.type !== undefined) type = options.type
    if (options.generateMipmaps !== undefined) values.generateMipmaps = options.generateMipmaps
    if (options.internalFormat !== undefined) values.internalFormat = options.internalFormat
    for (let i = 0; i < this.textures.length; i++) {
      const texture = /** @type {Texture} */ (this.textures[i])
      texture.minFilter = values.minFilter
      texture.generateMipmaps = values.generateMipmaps
      texture.internalFormat = values.internalFormat
      if (magFilter !== undefined) texture.magFilter = magFilter
      if (type !== undefined) texture.type = type
    }
  }
}

class CubeRenderTarget extends RenderTarget {
  /**
   * @param {number} [size=1]
   * @param {RenderTarget~Options} [options]
   */
  constructor(size = 1, options = {}) {
    super(size, size, options)
    this.isCube = true
    this.texture = new Texture()
    this._setTextureOptions(options)
  }
}

/** @param {RenderTarget} target */
const describe = (target) =>
  [target.width, target.depthBuffer, target.texture.type, target.texture.generateMipmaps, target.texture.internalFormat].join(',')

const plain = new RenderTarget(4, 4, { type: HalfFloatType, depthBuffer: true, minFilter: LinearFilter, magFilter: LinearFilter })
console.log('plain=' + describe(plain))
console.log('cube=' + describe(new CubeRenderTarget(1)))
/** @param {Array<number>} sizes */
const bake = (sizes) =>
  sizes
    .map((size) => new CubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false }))
    .map(describe)
    .join(';')
console.log('probes=' + bake([8, 16]))
console.log('named=' + describe(new CubeRenderTarget(2, { internalFormat: 'R16F' })))
