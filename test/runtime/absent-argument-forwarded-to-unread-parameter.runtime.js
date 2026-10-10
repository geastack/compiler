// A 3D renderer's `refreshMaterialUniforms( ..., transmissionRenderTarget )`
// receives `state.transmissionRenderTarget[ camera.id ]` -- a read of an open
// `{}` keyed by camera, `undefined` until the first transmissive draw creates
// the target -- and forwards it to `refreshUniformsPhysical`, which only reads
// it under `material.transmission > 0`. The absence travels with the value:
// forwarding an absent target is not a read of it, so it must not throw.
//
// The open `{}` is a bag (`object-bag-bindings.ts`) whose layout is `{ 7?:
// Target }`. The enclosing record's `targets` field must hold that layout too:
// left at the checker's `{}`, every access recast it into the bag by COPY, the
// write landed in a temporary, and the second call still saw no target.

export {}

class Target {
  /** @param {number} width */
  constructor(width) {
    this.width = width
  }
}

function Materials() {
  function refreshPhysical(uniforms, material, target) {
    if (material.transmission > 0) uniforms.size = target.width
    else uniforms.size = -1
  }
  function refresh(uniforms, material, target) {
    if (material.isPhysical) refreshPhysical(uniforms, material, target)
  }
  return { refresh }
}

function States() {
  const state = { targets: {} }
  return { state }
}

const materials = Materials()
const states = States()
const uniforms = { size: 0 }
materials.refresh(uniforms, { isPhysical: true, transmission: 0 }, states.state.targets[7])
const before = uniforms.size
states.state.targets[7] = new Target(4)
materials.refresh(uniforms, { isPhysical: true, transmission: 1 }, states.state.targets[7])
//! expect: -1 4
console.log(before + ' ' + uniforms.size)
