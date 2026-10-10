// @ts-nocheck
// `Object.assign( { defaults }, options )` returns the defaults literal with
// every key the caller's options state copied onto it -- including keys the
// defaults never spell. A later read of such a key must see the copied value,
// and a bag filled conditionally from those reads must enumerate it.
//! expect: 1016 1003 2 undefined
//! expect: minFilter=1006 type=1016 magFilter=1003
//! expect: undefined undefined 0 undefined
//! expect: minFilter=1006

/**
 * @typedef {Object} Options
 * @property {number} [type]
 * @property {number} [magFilter]
 * @property {number} [minFilter]
 * @property {number} [samples]
 * @property {string} [colorSpace]
 */

/** @param {Options} [options] */
function make(options = {}) {
  options = Object.assign({ minFilter: 1006, samples: 0 }, options)
  console.log(options.type, options.magFilter, options.samples, options.colorSpace)
  const values = { minFilter: 1006 }
  if (options.type !== undefined) values.type = options.type
  if (options.magFilter !== undefined) values.magFilter = options.magFilter
  if (options.colorSpace !== undefined) values.colorSpace = options.colorSpace
  const parts = []
  for (const key in values) parts.push(key + '=' + values[key])
  console.log(parts.join(' '))
}

make({ type: 1016, magFilter: 1003, samples: 2 })
make()
