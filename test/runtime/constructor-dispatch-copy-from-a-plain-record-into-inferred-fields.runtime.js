// @ts-nocheck
// A 3D scene-graph library's `Material.clone()` is `new this.constructor().copy(this)`: one
// constructor read dispatches over every material class, so the read's boxed
// argument crosses into each subclass's own typed `parameters` -- for
// ShadedSurface a union of the option records its callers pass, each holding
// a `uniforms` table of `{ value }` records keyed by name.
//
// The same `copy(source)` then takes a plain record with none of the shader
// keys. `vertexShader`, `depthTest` and `uniforms` are typed only by their
// constructor writes, so the copy stores `undefined` into each; the fields were
// laid out narrow and the first store aborted in its checked unbox.
function copyUniforms(src) {
  const dst = {}
  for (const u in src) {
    dst[u] = {}
    for (const p in src[u]) dst[u][p] = src[u][p]
  }
  return dst
}

class Surface {
  constructor() {
    this.name = ''
    this.type = 'Surface'
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

class ShadedSurface extends Surface {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super()
    this.type = 'ShadedSurface'
    this.uniforms = {}
    this.vertexShader = 'default'
    this.depthTest = true
    if (parameters !== undefined) this.setValues(parameters)
  }
  copy(source) {
    super.copy(source)
    this.uniforms = copyUniforms(source.uniforms)
    this.vertexShader = source.vertexShader
    this.depthTest = source.depthTest
    return this
  }
}

class RawShadedSurface extends ShadedSurface {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    super(parameters)
    this.type = 'RawShadedSurface'
  }
}

class MeshSurface extends Surface {
  constructor() {
    super()
    this.type = 'MeshSurface'
  }
}

const ShaderTable = {
  output: { uniforms: { tDiffuse: { value: null } } },
  blur: { uniforms: { envMap: { value: null }, weights: { value: null } } }
}
const raw = new RawShadedSurface({ uniforms: copyUniforms(ShaderTable.output.uniforms), vertexShader: 'raw', depthTest: false })
const shader = new ShadedSurface({ name: 'blur', uniforms: copyUniforms(ShaderTable.blur.uniforms), vertexShader: 'blurV' })
const mesh = new MeshSurface()
mesh.name = 'mesh'
console.log('built', Object.keys(raw.uniforms).join('+'), raw.depthTest, shader.name)
const rawCopy = raw.clone()
console.log(rawCopy.type, Object.keys(rawCopy.uniforms).join('+'), rawCopy.vertexShader, rawCopy.depthTest, rawCopy !== raw)
const shaderCopy = shader.clone()
console.log(shaderCopy.type, shaderCopy.name, Object.keys(shaderCopy.uniforms).join('+'), shaderCopy.vertexShader, shaderCopy.depthTest)
const meshCopy = mesh.clone()
console.log(meshCopy.type, meshCopy.name, meshCopy !== mesh)

rawCopy.copy({ name: 'plain' })
console.log(rawCopy.name, typeof rawCopy.vertexShader, Object.keys(rawCopy.uniforms).length)
//! expect: built tDiffuse false blur
//! expect: RawShadedSurface tDiffuse raw false true
//! expect: ShadedSurface blur envMap+weights blurV true
//! expect: MeshSurface mesh true
//! expect: plain undefined 0
export {}
