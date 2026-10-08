// @ts-nocheck
// Helper for node-library-native-registries.runtime.js: three's Material, the
// non-node materials the test converts, NodeMaterial and the thirteen node
// materials StandardNodeLibrary registers. A node material's `type` is its
// class's static `type`, and the setter ignores a write, as in three: the
// registry's copy of a material's fields writes `type` too.
export class Material {
  constructor() {
    this.isMaterial = true
    this.type = 'Material'
    this.name = ''
    this.opacity = 1
  }
}
export class MeshBasicMaterial extends Material {
  constructor() {
    super()
    this.type = 'MeshBasicMaterial'
  }
}
export class MeshStandardMaterial extends Material {
  constructor() {
    super()
    this.type = 'MeshStandardMaterial'
  }
}
export class UnregisteredMaterial extends Material {
  constructor() {
    super()
    this.type = 'UnregisteredMaterial'
  }
}
export class NodeMaterial extends Material {
  static get type() {
    return 'NodeMaterial'
  }
  get type() {
    return this.constructor.type
  }
  set type(_value) {}
  constructor() {
    super()
    this.isNodeMaterial = true
  }
}
export class MeshPhongNodeMaterial extends NodeMaterial {
  static get type() {
    return 'MeshPhongNodeMaterial'
  }
}
export class MeshStandardNodeMaterial extends NodeMaterial {
  static get type() {
    return 'MeshStandardNodeMaterial'
  }
}
export class MeshPhysicalNodeMaterial extends MeshStandardNodeMaterial {
  static get type() {
    return 'MeshPhysicalNodeMaterial'
  }
}
export class MeshToonNodeMaterial extends NodeMaterial {
  static get type() {
    return 'MeshToonNodeMaterial'
  }
}
export class MeshBasicNodeMaterial extends NodeMaterial {
  static get type() {
    return 'MeshBasicNodeMaterial'
  }
}
export class MeshLambertNodeMaterial extends NodeMaterial {
  static get type() {
    return 'MeshLambertNodeMaterial'
  }
}
export class MeshNormalNodeMaterial extends NodeMaterial {
  static get type() {
    return 'MeshNormalNodeMaterial'
  }
}
export class MeshMatcapNodeMaterial extends NodeMaterial {
  static get type() {
    return 'MeshMatcapNodeMaterial'
  }
}
export class LineBasicNodeMaterial extends NodeMaterial {
  static get type() {
    return 'LineBasicNodeMaterial'
  }
}
export class LineDashedNodeMaterial extends NodeMaterial {
  static get type() {
    return 'LineDashedNodeMaterial'
  }
}
export class SpriteNodeMaterial extends NodeMaterial {
  static get type() {
    return 'SpriteNodeMaterial'
  }
}
export class PointsNodeMaterial extends SpriteNodeMaterial {
  static get type() {
    return 'PointsNodeMaterial'
  }
}
export class ShadowNodeMaterial extends NodeMaterial {
  static get type() {
    return 'ShadowNodeMaterial'
  }
}
