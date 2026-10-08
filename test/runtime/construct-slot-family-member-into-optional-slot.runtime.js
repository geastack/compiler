// @ts-nocheck
//! expect: StandardMaterial
//! expect: PhysicalMaterial
//! expect: undefined
// construct-slot-family-member-conventions.runtime.js's two classes, stored
// into an OPTIONAL construct slot, as mongodb's `responseType?:
// MongoDBResponseConstructor`. The chain converts an optional's payload
// without the class table, so the census answers the optional itself over
// the layouts: each member's thunk still gets its own absent argument.
import { Material, StandardMaterial } from './_construct-slot-member-base.js'
import { PhysicalMaterial } from './_construct-slot-member-physical.js'

class Library {
  constructor() {
    /** @type {Map<string, (new () => Material) | undefined>} */
    this.materials = new Map()
  }
  /** @param {(new () => Material) | undefined} materialClass */
  addMaterial(materialClass, type) {
    this.materials.set(type, materialClass)
  }
  /** @param {string} type */
  create(type) {
    const materialClass = this.materials.get(type)
    return materialClass ? new materialClass() : null
  }
}

const library = new Library()
library.addMaterial(StandardMaterial, 'standard')
library.addMaterial(PhysicalMaterial, 'physical')
library.addMaterial(undefined, 'none')
for (const type of ['standard', 'physical', 'none']) console.log(library.create(type)?.type)
