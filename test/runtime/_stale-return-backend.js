// @ts-nocheck
// Helper for jsdoc-parameter-stale-return-unimported-receiver-keeps-tag.runtime.js.
// `Producer` is not imported, so the checker resolves `producer.getItem()` to
// no declaration.
import { Packed } from './_stale-return-source.js'
export class Backend {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
  }
  /** @param {Packed} item */
  key(item) {
    return item.n + ' ' + item.isPacked
  }
}
export class Drawer {
  /** @param {Backend} backend */
  constructor(backend) {
    this.backend = backend
  }
  /** @param {Producer} producer */
  draw(producer) {
    const item = producer.getItem()
    return this.backend.key(item)
  }
}
