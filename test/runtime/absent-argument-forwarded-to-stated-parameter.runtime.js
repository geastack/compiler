// The same forwarding as `absent-argument-forwarded-to-unread-parameter`, with
// the callee's parameter STATED by JSDoc -- a 3D library's type overlay writes
// `@param {RenderTarget} transmissionRenderTarget` into the library's own
// `refreshUniformsPhysical`, where the unstated repro had the census infer the
// slot. A stated parameter is outside inference, so its slot stayed the bare
// statement and the call threw on the absent target. The forwarded value
// carries the absence the callee never reads (`omitted-stated-parameter.ts`
// widens the slot for a passed `T | undefined` exactly as for an omitted
// argument).

export {}

class Target {
  /** @param {number} width */
  constructor(width) {
    this.width = width
  }
}

function Materials() {
  /** @param {{ size: number }} uniforms @param {{ transmission: number }} material @param {Target} target */
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
