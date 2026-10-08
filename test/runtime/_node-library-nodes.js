// @ts-nocheck
// Helper for node-library-native-registries.runtime.js: three's Node and its
// light nodes (nodes/lighting/*.js). A light node is made from the light it
// shades; IESSpotLightNode and ProjectorLightNode extend SpotLightNode. A
// node's `type` is its class's static `type`, as in three.
export class Node {
  static get type() {
    return 'Node'
  }
  get type() {
    return this.constructor.type
  }
  /** @param {number} [value] */
  constructor(value = 0) {
    this.isNode = true
    this.value = value
  }
  /** @param {Node} other */
  mul(other) {
    return new Node(this.value * other.value)
  }
  /** @param {number} offset */
  add(offset) {
    return new Node(this.value + offset)
  }
  clamp() {
    return new Node(Math.min(1, Math.max(0, this.value)))
  }
}
export class AnalyticLightNode extends Node {
  static get type() {
    return 'AnalyticLightNode'
  }
  /** @param {?import('./_node-library-lights.js').Light} [light] */
  constructor(light = null) {
    super()
    this.light = light
  }
}
export class PointLightNode extends AnalyticLightNode {
  static get type() {
    return 'PointLightNode'
  }
}
export class DirectionalLightNode extends AnalyticLightNode {
  static get type() {
    return 'DirectionalLightNode'
  }
}
export class RectAreaLightNode extends AnalyticLightNode {
  static get type() {
    return 'RectAreaLightNode'
  }
}
export class SpotLightNode extends AnalyticLightNode {
  static get type() {
    return 'SpotLightNode'
  }
}
export class AmbientLightNode extends AnalyticLightNode {
  static get type() {
    return 'AmbientLightNode'
  }
}
export class HemisphereLightNode extends AnalyticLightNode {
  static get type() {
    return 'HemisphereLightNode'
  }
}
export class LightProbeNode extends AnalyticLightNode {
  static get type() {
    return 'LightProbeNode'
  }
}
export class IESSpotLightNode extends SpotLightNode {
  static get type() {
    return 'IESSpotLightNode'
  }
}
export class ProjectorLightNode extends SpotLightNode {
  static get type() {
    return 'ProjectorLightNode'
  }
}
