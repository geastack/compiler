// @ts-nocheck
//! expect: keys color,_alpha,texture,alpha
//! expect: proto true true true
//! expect: descriptors alpha:get,clone:value
//! expect: node-basic 1 null nothing-copied
// three's prototype reflection on the renderer path, over native classes:
// `RenderObject.getKeys` walks `Object.getPrototypeOf` and lists every
// accessor from `Object.getOwnPropertyDescriptors(proto)`;
// `NodeMaterial.setDefaultValues` reads another material class's
// descriptors and copies only getters (a basic material has none). Past the
// root class the chain ends in `null` here, not `Object.prototype`: this
// runtime models no `Object.prototype` object, as for `{}`.
class ExtMaterial {
  constructor() {
    this.color = 1
    this._alpha = 0.5
  }
  get alpha() {
    return this._alpha
  }
  set alpha(v) {
    this._alpha = v
  }
  clone() {
    return new ExtMaterial()
  }
}
class ExtBasicMaterial extends ExtMaterial {
  constructor() {
    super()
    this.texture = null
  }
}
class ExtNodeMaterial extends ExtMaterial {}

function getKeys(obj) {
  const keys = Object.keys(obj)
  const protoKeys = []
  let proto = Object.getPrototypeOf(obj)
  while (proto) {
    const descriptors = Object.getOwnPropertyDescriptors(proto)
    for (const key in descriptors) {
      const descriptor = descriptors[key]
      if (descriptor && typeof descriptor.get === 'function' && key !== '__proto__') protoKeys.push(key)
    }
    proto = Object.getPrototypeOf(proto)
  }
  for (let i = 0; i < protoKeys.length; i++) keys.push(protoKeys[i])
  return keys
}
console.log('keys', getKeys(new ExtBasicMaterial()).join(','))

const basic = new ExtBasicMaterial()
const p1 = Object.getPrototypeOf(basic)
const p2 = Object.getPrototypeOf(p1)
const p3 = Object.getPrototypeOf(p2)
console.log('proto', p1 === ExtBasicMaterial.prototype, p2 === ExtMaterial.prototype, p3 === null || p3 === Object.prototype)

/** @type {any} */
const materialPrototype = ExtMaterial.prototype
const own = Object.getOwnPropertyDescriptors(materialPrototype)
const listed = []
for (const key in own) {
  if (key === 'constructor') continue
  listed.push(key + ':' + (own[key].get !== undefined ? 'get' : 'value'))
}
console.log('descriptors', listed.join(','))

/** @param {any} material */
function setDefaultValues(target, material) {
  for (const property in material) {
    if (target[property] === undefined) target[property] = material[property]
  }
  const descriptors = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(material))
  let copied = 'nothing-copied'
  for (const key in descriptors) {
    if (Object.getOwnPropertyDescriptor(ExtNodeMaterial.prototype, key) === undefined && descriptors[key].get !== undefined) {
      Object.defineProperty(ExtNodeMaterial.prototype, key, descriptors[key])
      copied = 'copied'
    }
  }
  return copied
}
const node = new ExtNodeMaterial()
const copied = setDefaultValues(node, new ExtBasicMaterial())
console.log('node-basic', node.color, node.texture, copied)
