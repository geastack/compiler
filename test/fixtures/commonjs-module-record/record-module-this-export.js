'use strict'

var __assign =
  (this && /** @type {any} */ (this).__assign) ||
  /**
   * @param {any} target
   * @param {any} source
   */
  function (target, source) {
    for (var key in source) target[key] = source[key]
    return target
  }
const arrowSeesModule = () => this === module.exports
module.exports.merged = __assign({ a: 1 }, { b: 2 })
module.exports.initialIsExports = this === module.exports
module.exports.arrowSeesModule = arrowSeesModule()
