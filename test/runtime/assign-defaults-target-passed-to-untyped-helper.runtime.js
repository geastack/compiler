// @ts-nocheck
// The object `Object.assign( { defaults }, options )` returns is handed to an
// untyped helper (`apply( options = {} )`), which tests and reads keys only the
// caller's options stated. The helper's parameter holds that same object, so
// each `!== undefined` test sees the copied value rather than the empty
// default's absence.
//! expect: 1016 1003 linear 2
//! expect: has type
//! expect: has colorSpace
//! expect: undefined undefined undefined 0

/**
 * @typedef {Object} Options
 * @property {number} [type]
 * @property {number} [magFilter]
 * @property {string} [colorSpace]
 * @property {number} [samples]
 */

class Target {
  /** @param {Options} [options] */
  constructor(options = {}) {
    options = Object.assign({ minFilter: 1006, samples: 0 }, options)
    this.apply(options)
  }

  apply(options = {}) {
    console.log(options.type, options.magFilter, options.colorSpace, options.samples)
    if (options.type !== undefined) console.log('has type')
    if (options.colorSpace !== undefined) console.log('has colorSpace')
  }
}

new Target({ type: 1016, magFilter: 1003, colorSpace: 'linear', samples: 2 })
new Target()
