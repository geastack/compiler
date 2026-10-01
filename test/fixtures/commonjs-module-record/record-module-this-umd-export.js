;(function (root) {
  'use strict'
  const lib = {}
  lib.Point = (function () {
    /** @param {number} x */
    function Point(x) {
      this.x = x
    }
    Point.prototype.double = function () {
      return this.x * 2
    }
    return Point
  })()
  /** @param {number} x */
  lib.parse = function (x) {
    return new lib.Point(x)
  }
  lib.rootWasEmpty = Object.keys(root).length === 0
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = lib
  } else {
    root.lib = lib
  }
})(this)
