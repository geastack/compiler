// @ts-nocheck
//! expect: point PointLightNode true | spot SpotLightNode true | spot none | light none
//! expect: true false
//! emitted-has: a constructor read off an instance is not a class its constructor family names
//! emitted-has: ::ofArm<
//! emitted-lacks: gea::WeakMap<gea::Value
// `light.constructor` handed to a parameter that states a union of light
// classes, which keys a WeakMap: three's LightsNode looks a light's node
// class up with `getLightNodeClass( light.constructor )` under NodeLibrary's
// `typeof Light | typeof PointLight | ...` key. The read is whichever class
// the light was allocated as, chosen at run time from its class evaluation
// and stored in that class's own arm, so the lookup finds the entry
// `addLight` made with the class itself. A subclass the registry does not
// name (`IESSpotLight` here) is its own key and finds nothing, as in
// JavaScript. The bound callback leaves the census of `get`'s callers open,
// so the stated tag must hold.
class Light {
  constructor(kind = 'light') {
    this.kind = kind
  }
}
class PointLight extends Light {
  constructor() {
    super('point')
  }
}
class SpotLight extends Light {
  constructor(kind = 'spot') {
    super(kind)
  }
}
class IESSpotLight extends SpotLight {}
class LightNode {
  static get type() {
    return 'LightNode'
  }
  /** @param {Light} light */
  constructor(light) {
    this.light = light
  }
}
class PointLightNode extends LightNode {
  static get type() {
    return 'PointLightNode'
  }
}
class SpotLightNode extends LightNode {
  static get type() {
    return 'SpotLightNode'
  }
}

class Library {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    /** @type {WeakMap<(typeof Light|typeof PointLight|typeof SpotLight|typeof IESSpotLight), (new (light: Light) => LightNode)>} */
    this.lightNodes = new WeakMap()
  }
  /**
   * @param {(new (light: Light) => LightNode)} lightNodeClass
   * @param {(typeof Light|typeof PointLight|typeof SpotLight|typeof IESSpotLight)} lightClass
   */
  addLight(lightNodeClass, lightClass) {
    this.lightNodes.set(lightClass, lightNodeClass)
  }
  /**
   * @param {(typeof Light|typeof PointLight|typeof SpotLight|typeof IESSpotLight)} light
   * @return {?(new (light: Light) => LightNode)}
   */
  getLightNodeClass(light) {
    return this.lightNodes.get(light) || null
  }
}

const library = new Library()
library.addLight(PointLightNode, PointLight)
library.addLight(SpotLightNode, SpotLight)

/** @param {Array<Light>} lights */
const describe = (lights) => {
  const out = []
  for (const light of lights) {
    const lightNodeClass = library.getLightNodeClass(light.constructor)
    if (lightNodeClass === null) {
      out.push(light.kind + ' none')
      continue
    }
    const node = new lightNodeClass(light)
    out.push(light.kind + ' ' + node.constructor.type + ' ' + (node.light === light))
  }
  return out.join(' | ')
}

console.log(describe([new PointLight(), new SpotLight(), new IESSpotLight(), new Light()]))
console.log(library.getLightNodeClass(new SpotLight().constructor) === SpotLightNode, library.getLightNodeClass(Light) === SpotLightNode)
