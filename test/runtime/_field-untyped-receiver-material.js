// @ts-nocheck
// `Builder` is named in the tags and imported nowhere here, as three's
// `NodeMaterial.js` names `NodeBuilder`.
export class Observer {
  /** @param {number} id */
  constructor(id) {
    this.id = id
  }
}
export class Material {
  constructor() {
    this.next = 7
  }
  /**
   * @param {Builder} builder
   * @return {Observer}
   */
  setupObserver(builder) {
    return new Observer(this.next++)
  }
  /** @param {Builder} builder */
  build(builder) {
    builder.observer = this.setupObserver(builder)
  }
}
