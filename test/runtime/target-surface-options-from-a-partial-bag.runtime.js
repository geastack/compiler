// @ts-nocheck
// A target's `_setSurfaceOptions( options = {} )` copies each surface option a
// caller's partial options record states into a `values` bag, then hands that
// bag to `Surface.setValues`, which walks it with `for...in` and writes each
// key onto the surface.
//
// The constructor itself rebinds its parameter, `options = Object.assign( {
// defaults }, options )`, and a subclass reaches it through `super( width,
// height, options )` from several call shapes: literal bags (one holding a
// conditional depth surface), one shared `params` bag handed to two targets
// through a helper, and a target constructed with no options at all. The
// options record is a typedef of optional fields; the helper method that copies
// from it and `setValues` are written the way an untyped JavaScript library
// writes them.

const UnsignedByteKind = 1009
const HalfFloatKind = 1016
const NearestFilter = 1003
const LinearFilter = 1006
const LinearMipmapLinearFilter = 1008
const ClampWrap = 1001
const RepeatWrap = 1000
const RgbaLayout = 1023
const DefaultMapping = 300
const CubeMapping = 306
const NoColorSpace = ''
const LinearColorSpace = 'linear'

class Surface {
  constructor(width = 1, height = 1) {
    this.width = width
    this.height = height
    /** @type {number} */
    this.mapping = DefaultMapping
    /** @type {number} */
    this.wrapS = ClampWrap
    /** @type {number} */
    this.wrapT = ClampWrap
    /** @type {number} */
    this.wrapR = ClampWrap
    /** @type {number} */
    this.magFilter = LinearFilter
    /** @type {number} */
    this.minFilter = LinearMipmapLinearFilter
    /** @type {number} */
    this.format = RgbaLayout
    /** @type {?string} */
    this.internalFormat = null
    /** @type {number} */
    this.type = UnsignedByteKind
    /** @type {number} */
    this.anisotropy = 1
    /** @type {string} */
    this.colorSpace = NoColorSpace
    /** @type {boolean} */
    this.generateMipmaps = true
    /** @type {boolean} */
    this.flipY = true
    /** @type {Target | null} */
    this.owner = null
  }

  /**
   * @param {Object} values
   */
  setValues(values) {
    if (values === undefined) return
    for (const key in values) {
      const newValue = values[key]
      if (newValue === undefined) {
        continue
      }
      const currentValue = this[key]
      if (currentValue === undefined) {
        continue
      }
      this[key] = newValue
    }
  }
}

class DepthSurface extends Surface {
  constructor(width, height) {
    super(width, height)
    this.isDepthSurface = true
    this.magFilter = NearestFilter
    this.minFilter = NearestFilter
    this.flipY = false
    this.generateMipmaps = false
  }
}

/**
 * @typedef {Object} TargetOptions
 * @property {boolean} [generateMipmaps=false]
 * @property {number} [magFilter=LinearFilter]
 * @property {number} [minFilter=LinearFilter]
 * @property {number} [format=RgbaLayout]
 * @property {number} [type=UnsignedByteKind]
 * @property {?string} [internalFormat=null]
 * @property {number} [mapping=DefaultMapping]
 * @property {number} [wrapS=ClampWrap]
 * @property {number} [wrapT=ClampWrap]
 * @property {number} [wrapR=ClampWrap]
 * @property {number} [anisotropy=1]
 * @property {string} [colorSpace=NoColorSpace]
 * @property {boolean} [flipY=false]
 * @property {boolean} [depthBuffer=true]
 * @property {boolean} [stencilBuffer=false]
 * @property {?DepthSurface} [depthSurface=null]
 * @property {number} [samples=0]
 * @property {number} [count=1]
 */

class Target {
  /**
   * @param {number} [width=1]
   * @param {number} [height=1]
   * @param {TargetOptions} [options]
   */
  constructor(width = 1, height = 1, options = {}) {
    options = Object.assign(
      {
        generateMipmaps: false,
        internalFormat: null,
        minFilter: LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        depthSurface: null,
        samples: 0,
        count: 1
      },
      options
    )
    this.isTarget = true
    this.width = width
    this.height = height
    this.scissorTest = false

    const surface = new Surface(width, height)
    surface.flipY = false
    surface.generateMipmaps = options.generateMipmaps
    surface.internalFormat = options.internalFormat

    /** @type {Array<Surface>} */
    this.surfaces = []
    const count = options.count
    for (let i = 0; i < count; i++) {
      this.surfaces[i] = surface
      this.surfaces[i].owner = this
    }
    this._setSurfaceOptions(options)

    this.depthBuffer = options.depthBuffer
    this.stencilBuffer = options.stencilBuffer
    /** @type {DepthSurface | null} */
    this._depthSurface = null
    this.depthSurface = options.depthSurface
    this.samples = options.samples
  }

  /** @return {Surface} */
  get surface() {
    return this.surfaces[0]
  }

  /** @param {DepthSurface | null} current */
  set depthSurface(current) {
    if (this._depthSurface === current) return
    if (this._depthSurface !== null) this._depthSurface.owner = null
    if (current !== null) current.owner = this
    this._depthSurface = current
  }

  /** @return {DepthSurface | null} */
  get depthSurface() {
    return this._depthSurface
  }

  _setSurfaceOptions(options = {}) {
    const values = {
      minFilter: LinearFilter,
      generateMipmaps: false,
      flipY: false,
      internalFormat: null
    }
    if (options.mapping !== undefined) values.mapping = options.mapping
    if (options.wrapS !== undefined) values.wrapS = options.wrapS
    if (options.wrapT !== undefined) values.wrapT = options.wrapT
    if (options.wrapR !== undefined) values.wrapR = options.wrapR
    if (options.magFilter !== undefined) values.magFilter = options.magFilter
    if (options.minFilter !== undefined) values.minFilter = options.minFilter
    if (options.format !== undefined) values.format = options.format
    if (options.type !== undefined) values.type = options.type
    if (options.anisotropy !== undefined) values.anisotropy = options.anisotropy
    if (options.colorSpace !== undefined) values.colorSpace = options.colorSpace
    if (options.flipY !== undefined) values.flipY = options.flipY
    if (options.generateMipmaps !== undefined) values.generateMipmaps = options.generateMipmaps
    if (options.internalFormat !== undefined) values.internalFormat = options.internalFormat
    for (let i = 0; i < this.surfaces.length; i++) {
      this.surfaces[i].setValues(values)
    }
  }
}

class DeviceTarget extends Target {
  /**
   * @param {number} [width=1]
   * @param {number} [height=1]
   * @param {TargetOptions} [options]
   */
  constructor(width = 1, height = 1, options = {}) {
    super(width, height, options)
    this.isDeviceTarget = true
  }
}

const target = new Target(4, 2, { type: HalfFloatKind, magFilter: NearestFilter, samples: 2 })
console.log(
  target.surface.type === HalfFloatKind,
  target.surface.magFilter === NearestFilter,
  target.samples,
  target.width,
  target.surface.flipY
)
const plain = new Target()
console.log(plain.surface.type === UnsignedByteKind, plain.depthBuffer, plain.surface.generateMipmaps)

function output(type, width, height, antialias, depth, stencil) {
  const targetA = new DeviceTarget(width, height, {
    type: type,
    depthBuffer: depth,
    stencilBuffer: stencil,
    samples: antialias ? 4 : 0,
    depthSurface: depth ? new DepthSurface(width, height) : undefined
  })
  const targetB = new DeviceTarget(width, height, { type: HalfFloatKind, depthBuffer: false, stencilBuffer: false })
  return { targetA, targetB }
}
const { targetA: a, targetB: b } = output(UnsignedByteKind, 8, 6, true, true, false)
const depthSurface = a.depthSurface
console.log(
  a.surface.type === UnsignedByteKind,
  depthSurface !== null && depthSurface.owner === a,
  a.samples,
  a.stencilBuffer,
  b.depthBuffer,
  b.surface.type === HalfFloatKind
)

function createTarget(width, height, params) {
  const created = new DeviceTarget(width, height, params)
  created.surface.mapping = CubeMapping
  created.scissorTest = true
  return created
}
const params = {
  magFilter: LinearFilter,
  minFilter: LinearFilter,
  generateMipmaps: false,
  type: HalfFloatKind,
  format: RgbaLayout,
  colorSpace: LinearColorSpace,
  wrapS: RepeatWrap,
  depthBuffer: false
}
const cube = createTarget(12, 16, params)
const pingPong = createTarget(12, 16, params)
console.log(
  cube.surface.colorSpace === LinearColorSpace,
  cube.depthBuffer,
  pingPong.surface.mapping === CubeMapping,
  pingPong.surface.format === RgbaLayout
)

const small = new DeviceTarget(2, 2)
console.log(small.surface.type === UnsignedByteKind, small.width, small.isDeviceTarget)

//! expect: true true 2 4 false
//! expect: true true false
//! expect: true true 4 false false true
//! expect: true false true true
//! expect: true 2 true
