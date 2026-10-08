// @ts-nocheck
//! expect: StandardMaterial StandardMaterial true
//! expect: PhysicalMaterial StandardMaterial,PhysicalMaterial true
//! expect: null
//! emitted-has: gea::Map<std::string, gea::ConstructorObject<
//! emitted-lacks: gea::Map<std::string, gea::Value
// A class and its subclass registered in one `new () => Material` slot and
// constructed through it, as three's StandardNodeLibrary registers
// MeshStandardNodeMaterial and MeshPhysicalNodeMaterial. Storing the subclass
// makes it a member of the base's constructor family, but its construct thunk
// keeps its own convention: the base's `parameters` is closed to `undefined`
// by its one caller, the subclass's `super()`, while the subclass's has no
// caller and stays open. The slot's adapter has to call each member's thunk
// with that member's own absent argument.
import { Material, StandardMaterial } from './_construct-slot-member-base.js'
import { PhysicalMaterial } from './_construct-slot-member-physical.js'

class Library {
  constructor() {
    /** @type {Map<string, new () => Material>} */
    this.materials = new Map()
  }
  /** @param {new () => Material} materialClass */
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
for (const type of ['standard', 'physical', 'basic']) {
  const material = library.create(type)
  console.log(material === null ? null : `${material.type} ${material.absent.join(',')} ${material instanceof Material}`)
}
