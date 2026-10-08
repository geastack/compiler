// @ts-nocheck
// Helper for jsdoc-parameter-stale-return-unimported-receiver-open-census-refused.runtime.js.
// `Producer` is not imported, so the checker resolves `producer.getItem()` to
// no declaration.
import { Other } from './_stale-return-source.js'
export class Backend {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
  }
  /** @param {Other} item */
  key(item) {
    return String(item.n)
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
