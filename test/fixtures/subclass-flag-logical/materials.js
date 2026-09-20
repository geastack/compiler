export class Material {
  constructor() {
    this.isMaterial = true
    this.visible = true
  }
}

export class MeshBasicMaterial extends Material {
  constructor() {
    super()
    this.isMeshBasicMaterial = true
  }
}

export class MeshPhongMaterial extends Material {
  constructor() {
    super()
    this.isMeshPhongMaterial = true
  }
}

export class ShaderMaterial extends Material {
  constructor() {
    super()
    this.isShaderMaterial = true
    this.lights = false
  }
}
