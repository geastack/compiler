class Node {
  /** @param {number} weight */
  constructor(weight) {
    this.weight = weight
  }

  /** @returns {number} */
  value() {
    return this.weight
  }
}

export default Node
