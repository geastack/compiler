export class Attribute {
  /**
   * @param {string} name
   * @param {?string} [type=null]
   * @param {Set<string>} [seen=null]
   */
  constructor(name, type = null, seen = null) {
    /** @type {string} */
    this.uuid = null
    /** @type {string} */
    this.label = 'attribute'
    this.name = name
    this.type = type
    this.seen = seen
  }
  /** @return {string} */
  ternary() {
    return null
  }
  /** @return {string} */
  kind() {
    return 'attribute'
  }
}

export class Color extends Attribute {
  constructor() {
    super(null)
  }
}
