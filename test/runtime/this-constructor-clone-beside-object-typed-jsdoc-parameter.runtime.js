// @ts-nocheck
// `new this.constructor()` -- a 3D scene-graph library's clone idiom -- in a program where a
// JSDoc-typed `Object` parameter exists. `Object` carries `constructor:
// Function`, so the bare `Function` interface becomes a bound host protocol,
// and the callee of the (asserted) `new` was published as that protocol's
// carrier instead of the construct signature the assertion states, refusing
// with `call-abi:no-construct-path:constructor-identity`.
export class Box {
  constructor(min = 1) {
    this.min = min
  }
  clone() {
    return new this.constructor()
  }
}

/**
 * @param {Object} options
 */
export function takes(options) {}

console.log(new Box().clone().min)
//! expect: 1
