import { Leaf } from './_type-only-class-leaf.js'
import { Wide } from './_type-only-class-wide.js'

export class Holder {
  constructor() {
    /** @type {Leaf | null} */
    this.slot = null
    this.wide = new Wide()
  }

  /** @returns {string} */
  describe() {
    return this.slot === null ? 'empty' : 'full'
  }
}
