import { Material, MeshBasicMaterial, MeshPhongMaterial, ShaderMaterial } from './materials.js'

// three's `WebGLProperties`: one lazily created `{}` per object, handed out
// through the factory's returned `get`.
function WebGLProperties() {
  let properties = new WeakMap()

  function get(object) {
    let map = properties.get(object)
    if (map === undefined) {
      map = {}
      properties.set(object, map)
    }

    return map
  }

  return {
    get: get
  }
}

const properties = WebGLProperties()

// three's `WebGLRenderer.materialNeedsLights`, reduced: a `MeshBasicMaterial`
// declares none of these flags, so the chain ends on `undefined && ...` and
// the call returns `undefined`, not `false`.
function materialNeedsLights(material) {
  return material.isMeshPhongMaterial || (material.isShaderMaterial && material.lights === true)
}

/**
 * @param {Material} material
 */
export function prepare(material) {
  const materialProperties = properties.get(material)
  materialProperties.needsLights = materialNeedsLights(material)
  return materialProperties.needsLights
}

prepare(new MeshBasicMaterial())
prepare(new MeshPhongMaterial())
prepare(new ShaderMaterial())
