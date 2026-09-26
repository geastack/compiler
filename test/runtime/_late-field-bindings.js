// @ts-nocheck
// Helper for jsdoc-field-tag-names-an-unimported-default-export.runtime.js.
class Bindings {
  /** @param {Pipelines} pipelines */
  constructor(pipelines) {
    /** @type {Pipelines} */
    this.pipelines = pipelines
    this.items = [1, 2]
    this.pipelines.bindings = this
  }
  size() {
    return this.items.length
  }
}
export default Bindings
