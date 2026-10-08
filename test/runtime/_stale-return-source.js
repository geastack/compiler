// @ts-nocheck
// Helper for jsdoc-parameter-stale-return-unimported-receiver-*.runtime.js.
export class Plain {
  constructor(n) {
    this.n = n
  }
}
export class Packed {
  constructor(n) {
    this.n = n
    this.isPacked = true
  }
}
export class Other {
  constructor(n) {
    this.n = n
    this.isOther = true
  }
}
class Source {
  constructor() {
    this.item = new Packed(2)
  }
}
export default Source
