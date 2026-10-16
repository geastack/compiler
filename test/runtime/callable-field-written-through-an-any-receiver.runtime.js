//! expect: typed patched:Lambert sf:Lambert type,onBeforeCompile,customProgramCacheKey
//! expect: fresh patched:Lambert sf:Lambert type,onBeforeCompile,customProgramCacheKey

// A Function-typed own slot written through an `any` receiver: three.js's
// `onBeforeCompile` and `customProgramCacheKey` are prototype methods, a typed
// write gives the instance an own callable field, and a patch helper reached
// through a function table assigns new arrows to both. The write reaches the
// field's dynamic `[[Set]]` (`typed`, slot present) and `[[DefineOwnProperty]]`
// (`fresh`, slot absent). Both used to abort with "a declared field whose
// carrier this runtime cannot box or unbox"; the stored Function must instead
// be the one later typed calls run.
//
// Verified against Node: both lines print
// `patched:Lambert sf:Lambert type,onBeforeCompile,customProgramCacheKey`.

class PatchedMaterial {
  constructor() {
    this.type = 'Lambert'
  }
  onBeforeCompile(shader) {}
  customProgramCacheKey() {
    return 'prototype'
  }
}

const typed = new PatchedMaterial()
typed.onBeforeCompile = (shader) => {
  shader.tag = 'typed'
}
typed.customProgramCacheKey = () => 'typed'
const fresh = new PatchedMaterial()

function patchMaterial(material) {
  material.onBeforeCompile = (shader) => {
    shader.tag = 'patched:' + material.type
  }
  material.customProgramCacheKey = () => 'sf:' + material.type
  return material
}
function keepMaterial(material) {
  return material
}
/** @type {Array<typeof patchMaterial>} */
const steps = [patchMaterial, keepMaterial]
for (const step of steps) {
  step(typed)
  step(fresh)
}

function report(label, material) {
  const shader = { tag: '' }
  material.onBeforeCompile(shader)
  console.log(label, shader.tag, material.customProgramCacheKey(), Object.keys(material).join(','))
}
report('typed', typed)
report('fresh', fresh)
