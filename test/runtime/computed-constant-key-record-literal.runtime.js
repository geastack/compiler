// @ts-nocheck
//! expect: 3 null render
// three's `Backend.timestampQueryPool` (`renderers/common/Backend.js`): an
// object literal whose members are computed keys read off a constants
// literal, laid out as the record its `@type` states. The keys are typed
// `string` (three's `ConstantsTimestampQuery` states them so), but each
// reads a slot nothing rewrites, so each member is the static definition of
// one field. `computed-constant-key.test.ts` pins the imported form.

/**
 * @typedef {Object} ConstantsTimestampQuery
 * @property {string} COMPUTE
 * @property {string} RENDER
 */

/** @type {ConstantsTimestampQuery} */
const TimestampQuery = { COMPUTE: 'compute', RENDER: 'render' }
class Pool { constructor(n) { this.n = n } }
class Backend {
  constructor() {
    /** @type {{render: ?Pool, compute: ?Pool}} */
    this.timestampQueryPool = {
      [ TimestampQuery.RENDER ]: null,
      [ TimestampQuery.COMPUTE ]: null
    };
  }
}
const b = new Backend()
b.timestampQueryPool.render = new Pool(3)
console.log(b.timestampQueryPool.render.n, b.timestampQueryPool.compute, TimestampQuery.RENDER)
