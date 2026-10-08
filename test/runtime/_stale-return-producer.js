// @ts-nocheck
// Helper for jsdoc-parameter-stale-return-unimported-receiver-*.runtime.js.
// `Source` is not imported: only the program-wide name reads the field's tag.
import { Plain } from './_stale-return-source.js'
class Producer {
  /** @param {Source} source */
  constructor(source) {
    /** @type {Source} */
    this.source = source
  }
  /** @return {Plain} The item. */
  getItem() {
    return this.source.item
  }
}
export default Producer
