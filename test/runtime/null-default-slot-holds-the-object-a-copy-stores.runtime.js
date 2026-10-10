// A defaults literal spells an object-valued option as `null`, and
// `Object.assign( { defaults }, options )` makes that literal the options
// object every later read sees. The checker's `T & U` result types the slot
// `null & ( Surface | null | undefined )`, which is `null`; at run time the
// copy stores whatever the source states -- here an instance or `undefined` --
// over the default, exactly as `{ ...defaults, ...options }` would. The slot
// must be typed by every value the copy can store into it.
//! expect: depth true true 4 0

class Surface {
  constructor() {
    this.name = 'surface'
  }
}

class DepthSurface extends Surface {
  constructor() {
    super()
    this.name = 'depth'
  }
}

/**
 * @typedef {Object} TargetOptions
 * @property {Surface|null} [depthSurface]
 * @property {number} [samples]
 */

class Target {
  /** @param {TargetOptions} [options] */
  constructor(options = {}) {
    options = Object.assign({ depthSurface: null, samples: 0 }, options)
    this.depthSurface = options.depthSurface
    this.samples = options.samples
  }
}

const withDepth = new Target({ depthSurface: new DepthSurface(), samples: 4 })
const withUndefined = new Target({ depthSurface: undefined })
const withNone = new Target()
console.log(
  withDepth.depthSurface ? withDepth.depthSurface.name : 'none',
  withUndefined.depthSurface === undefined,
  withNone.depthSurface === null,
  withDepth.samples,
  withNone.samples
)
