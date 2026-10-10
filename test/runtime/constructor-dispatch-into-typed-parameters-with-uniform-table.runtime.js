// @ts-nocheck
// A 3D scene-graph library's `Material.clone()` is `new this.constructor().copy(this)`: one
// constructor read dispatches over every material class, so the read's boxed
// argument crosses into each subclass's own typed `parameters` -- for
// ShadedMaterial a union of the option records its callers pass, each holding
// a `uniforms` table of `{ value }` records keyed by name.
function cloneUniforms(src) {
  const dst = {}
  for (const u in src) {
    dst[u] = {}
    for (const p in src[u]) dst[u][p] = src[u][p]
  }
  return dst
}

class Material {
  constructor() {
    this.name = ''
    this.type = 'Material'
  }
  setValues(values) {
    if (values === undefined) return
    for (const key in values) {
      const newValue = values[key]
      if (newValue === undefined) continue
      if (this[key] === undefined) continue
      this[key] = newValue
    }
  }
  copy(source) {
    this.name = source.name
    return this
  }
  clone() {
    return new this.constructor().copy(this)
  }
}

class ShadedMaterial extends Material {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super()
    this.type = 'ShadedMaterial'
    this.uniforms = {}
    this.vertexShader = 'default'
    this.depthTest = true
    if (parameters !== undefined) this.setValues(parameters)
  }
  copy(source) {
    super.copy(source)
    this.uniforms = cloneUniforms(source.uniforms)
    this.vertexShader = source.vertexShader
    this.depthTest = source.depthTest
    return this
  }
}

class RawShadedMaterial extends ShadedMaterial {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super(parameters)
    this.type = 'RawShadedMaterial'
  }
}

class MeshMaterial extends Material {
  constructor() {
    super()
    this.type = 'MeshMaterial'
  }
}

const ShaderLib = {
  output: { uniforms: { tDiffuse: { value: null } } },
  blur: { uniforms: { envMap: { value: null }, weights: { value: null } } }
}
const raw = new RawShadedMaterial({ uniforms: cloneUniforms(ShaderLib.output.uniforms), vertexShader: 'raw', depthTest: false })
const shader = new ShadedMaterial({ name: 'blur', uniforms: cloneUniforms(ShaderLib.blur.uniforms), vertexShader: 'blurV' })
const mesh = new MeshMaterial()
mesh.name = 'mesh'
console.log('built', Object.keys(raw.uniforms).join('+'), raw.depthTest, shader.name)
const rawCopy = raw.clone()
console.log(rawCopy.type, Object.keys(rawCopy.uniforms).join('+'), rawCopy.vertexShader, rawCopy.depthTest, rawCopy !== raw)
const shaderCopy = shader.clone()
console.log(shaderCopy.type, shaderCopy.name, Object.keys(shaderCopy.uniforms).join('+'), shaderCopy.vertexShader, shaderCopy.depthTest)
const meshCopy = mesh.clone()
console.log(meshCopy.type, meshCopy.name, meshCopy !== mesh)

//! expect: RawShadedMaterial tDiffuse raw false true
//! expect: ShadedMaterial blur envMap+weights blurV true
//! expect: MeshMaterial mesh true

export {}
