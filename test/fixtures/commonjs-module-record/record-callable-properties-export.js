'use strict'

/** @param {number} value */
function create(value) {
  return { value }
}

module.exports = create
module.exports.create = create
module.exports.default = create
