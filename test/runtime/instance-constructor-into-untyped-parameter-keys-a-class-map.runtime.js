// @ts-nocheck
//! expect: point PointLightNode true | spot none false | base none false | point PointLightNode true
// `light.constructor` handed to a parameter whose tag names no type
// (`{Light.constructor}` resolves to nothing, so the parameter is `any`) is
// the class itself: three's LightsNode looks a light's node class up this way
// (NodeLibrary's getLightNodeClass), in a Map keyed by the class objects
// addLight stored. The boxed class must be the same function object as the
// one the Map was keyed by, so the lookup finds it and `===` agrees.
class Light {
  constructor(kind) {
    this.kind = kind
  }
}
class PointLight extends Light {
  constructor() {
    super('point')
  }
}
class SpotLight extends Light {
  constructor() {
    super('spot')
  }
}
class PointLightNode {}
class Library {
  constructor() {
    this.lightNodes = new Map()
  }
  /**
   * @param {Light.constructor} light - The light class definition.
   * @return {PointLightNode.constructor|undefined} The light node class.
   */
  getLightNodeClass(light) {
    return this.lightNodes.get(light)
  }
  /**
   * @param {PointLightNode.constructor} lightNodeClass
   * @param {Light.constructor} lightClass
   */
  addLight(lightNodeClass, lightClass) {
    this.lightNodes.set(lightClass, lightNodeClass)
  }
  /** @param {Light.constructor} light */
  isPoint(light) {
    return light === PointLight
  }
}
const library = new Library()
library.addLight(PointLightNode, PointLight)
/** @type {Light[]} */
const lights = [new PointLight(), new SpotLight(), new Light('base'), new PointLight()]
const parts = []
for (const light of lights) {
  const nodeClass = library.getLightNodeClass(light.constructor)
  parts.push(light.kind + ' ' + (nodeClass === undefined ? 'none' : nodeClass.name) + ' ' + library.isPoint(light.constructor))
}
console.log(parts.join(' | '))
