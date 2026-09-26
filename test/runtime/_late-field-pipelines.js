// @ts-nocheck
// Helper for jsdoc-field-tag-names-an-unimported-default-export.runtime.js.
class Pipelines {
  constructor(backend) {
    this.backend = backend
    /**
     * Set by the `Bindings` constructor; this file never imports it.
     *
     * @type {?Bindings}
     * @default null
     */
    this.bindings = null
  }
  count() {
    return this.bindings === null ? -1 : this.bindings.size()
  }
}
export default Pipelines
