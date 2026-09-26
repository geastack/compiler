// @ts-nocheck
// `Missing` is named in the tag and declared nowhere, as three's
// `RenderObject.js` names `RenderPipeline`.
export class RenderItem {
  /** @param {string} key */
  constructor(key) {
    this.key = key
    /**
     * @type {Missing}
     * @default null
     */
    this.pipeline = null
  }
}
