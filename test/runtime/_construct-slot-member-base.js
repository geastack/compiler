// @ts-nocheck
// Helper for the construct-slot-family-member tests: the base
// class, and a class whose optional `parameters` only its subclass's
// `super()` passes, so its census closes it to `undefined`.
export class Material {
  constructor() {
    this.type = 'Material'
    /** @type {string[]} */
    this.absent = []
  }
}

export class StandardMaterial extends Material {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super()
    this.type = 'StandardMaterial'
    if (parameters === undefined) this.absent.push('StandardMaterial')
  }
}
