// three's `WebGLRenderer.clippingPlanes` / `UniformsGroup.uniforms` shape: an
// assignment-only field's own JSDoc `@type` tag names a CONCRETE element
// type, the field's one write is an empty array literal the evolving-array
// checker calls `never[]` (correctly silent as evidence -- nothing about the
// element can be read off `[]` itself), and real values are pushed into it
// from a different method. The annotation already states the storage
// completely, so this field must defer to the checker's own (JSDoc-informed)
// answer rather than become a census candidate that can only ever refuse.
export class Plane {}

export class Holder {
  constructor() {
    /**
     * @type {Array<Plane>}
     */
    this.clippingPlanes = []
  }

  addPlane(plane) {
    this.clippingPlanes.push(plane)
  }
}

// NEGATIVE CONTROL. `Array<Object>` states nothing about its element -- the
// same vacuous `Object` this codebase already refuses to read as evidence for
// a bare `@type {Object}` field -- so this annotation must NOT be read as
// "fully described": the field stays a census candidate, and its one write
// (`e[ 12 ]`, `e` an unannotated parameter -- the exact shape `Vector3`'s own
// `x`/`y`/`z` writes carry) is genuinely silent evidence, so the field must
// still refuse exactly as it did before this exclusion existed.
export class VacuousHolder {
  constructor(e) {
    /**
     * @type {Array<Object>}
     */
    this.entries = e[12]
  }
}

const holder = new Holder()
holder.addPlane(new Plane())
console.log(holder.clippingPlanes.length)

const vacuous = new VacuousHolder([])
console.log(vacuous.entries)
