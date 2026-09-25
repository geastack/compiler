'use strict'

module.exports = function answer() {
  return 42
}
module.exports.thisIsInitialExports = this !== module.exports && typeof this === 'object'
