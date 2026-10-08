// @ts-nocheck
// Helper for node-library-native-registries.runtime.js: three's light classes
// (lights/*.js), reduced to the fields the registry test reads. IESSpotLight
// and ProjectorLight extend SpotLight, as in three.
export class Light {
  /** @param {number} [color] @param {number} [intensity] */
  constructor(color = 0xffffff, intensity = 1) {
    this.isLight = true
    this.type = 'Light'
    this.color = color
    this.intensity = intensity
  }
}
export class PointLight extends Light {
  constructor(color, intensity, distance = 0) {
    super(color, intensity)
    this.isPointLight = true
    this.type = 'PointLight'
    this.distance = distance
  }
}
export class DirectionalLight extends Light {
  constructor(color, intensity) {
    super(color, intensity)
    this.isDirectionalLight = true
    this.type = 'DirectionalLight'
  }
}
export class RectAreaLight extends Light {
  constructor(color, intensity, width = 10) {
    super(color, intensity)
    this.isRectAreaLight = true
    this.type = 'RectAreaLight'
    this.width = width
  }
}
export class SpotLight extends Light {
  constructor(color, intensity, angle = Math.PI / 3) {
    super(color, intensity)
    this.isSpotLight = true
    this.type = 'SpotLight'
    this.angle = angle
  }
}
export class AmbientLight extends Light {
  constructor(color, intensity) {
    super(color, intensity)
    this.isAmbientLight = true
    this.type = 'AmbientLight'
  }
}
export class HemisphereLight extends Light {
  constructor(color, intensity) {
    super(color, intensity)
    this.isHemisphereLight = true
    this.type = 'HemisphereLight'
  }
}
export class LightProbe extends Light {
  constructor(intensity = 1) {
    super(undefined, intensity)
    this.isLightProbe = true
  }
}
export class IESSpotLight extends SpotLight {
  constructor(color, intensity, angle) {
    super(color, intensity, angle)
    this.iesMap = null
  }
}
export class ProjectorLight extends SpotLight {
  constructor(color, intensity, angle) {
    super(color, intensity, angle)
    this.aspect = null
  }
}
