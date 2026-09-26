// @ts-nocheck
// `RenderItem` is named in the tags and imported nowhere here, as three's
// `Pipelines.js` names `RenderObject`.
export class Pipeline {
  /** @param {number} id */
  constructor(id) {
    this.id = id
  }
}
export class Pipelines {
  constructor() {
    this.cache = new Map()
    this.next = 1
  }
  /**
   * @param {RenderItem} item
   * @param {?Array<Promise>} [promises=null]
   */
  getFor(item, promises = null) {
    if (promises !== null) promises.push(Promise.resolve())
    let pipeline = this.cache.get(item.key)
    if (pipeline === undefined) {
      pipeline = new Pipeline(this.next++)
      this.cache.set(item.key, pipeline)
    }
    item.pipeline = pipeline
  }
}
