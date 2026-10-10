// @ts-nocheck
// A method's `options = {}` default gives the parameter the checker type `{}`,
// the empty literal's own record. Its callers hand it a full options record,
// so `options.size` and `options.label` are present at runtime although the
// literal declares neither.
//
// The parameter census cannot bind the parameter to its callers here: the
// holder is stored inside its own parts and handed back out through a getter
// whose result the escape proof does not follow. The parameter therefore keeps
// the `{}` record, and a key that record lacks must stay a runtime lookup on
// whatever the caller passed; a closed-literal absence answer taken from the
// default's type alone folds every presence test to `false`.

class Part {
  constructor() {
    /** @type {Holder | null} */
    this.owner = null
  }
}

/**
 * @typedef {Object} HolderOptions
 * @property {number} [size]
 * @property {string} [label]
 * @property {number} [depth]
 */

class Holder {
  /** @param {HolderOptions} [options] */
  constructor(options = {}) {
    options = Object.assign({ label: 'plain' }, options)
    /** @type {Array<Part>} */
    this.parts = [new Part()]
    this.parts[0].owner = this
    this._apply(options)
  }

  /** @return {Part} */
  get part() {
    return this.parts[0]
  }

  _apply(options = {}) {
    console.log(options.size !== undefined, options.label !== undefined, options.depth !== undefined)
  }
}

const holder = new Holder({ size: 2 })
console.log(holder.part.owner === holder)
//! expect: true true false
//! expect: true
