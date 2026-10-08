// @ts-nocheck
// Helper for the construct-slot-family-member tests: a subclass
// in its own module whose optional `parameters` has no caller at all, so its
// census keeps the declared open `Object`.
import { StandardMaterial } from './_construct-slot-member-base.js'

export class PhysicalMaterial extends StandardMaterial {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super()
    this.type = 'PhysicalMaterial'
    if (parameters === undefined) this.absent.push('PhysicalMaterial')
  }
}
