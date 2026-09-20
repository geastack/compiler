class ProjectionTarget {
  /** @param {string} kind */
  constructor(kind) {
    this.kind = kind
  }
}

class ProjectionWebGLTarget extends ProjectionTarget {
  /** @param {string} kind */
  constructor(kind) {
    super(kind)
  }
}

class ProjectionCubeTarget extends ProjectionTarget {
  constructor() {
    super('cube')
  }
}

class ProjectionShadowBase {
  constructor() {
    /** @type {ProjectionTarget|null}
     * @geaSubclassMemberOverlay */
    this.map = null
  }
}

class ProjectionShadow extends ProjectionShadowBase {
  /** @type {ProjectionWebGLTarget|ProjectionCubeTarget|null} */
  map = null

  /** @param {number} choice */
  choose(choice) {
    if (choice === 0) {
      this.map = null
    } else if (choice === 1) {
      this.map = new ProjectionWebGLTarget('webgl')
    } else {
      this.map = new ProjectionCubeTarget()
    }
    return this.map
  }
}

class ProjectionLeftShadow extends ProjectionShadow {
  /** @param {number} choice */
  constructor(choice) {
    super()
    this.choose(choice)
  }
}

class ProjectionRightShadow extends ProjectionShadow {
  /** @param {number} choice */
  constructor(choice) {
    super()
    this.choose(choice)
  }
}

/** @param {boolean} left @param {number} choice */
const readProjectionUnion = (left, choice) => {
  const holder = left ? new ProjectionLeftShadow(choice) : new ProjectionRightShadow(choice)
  return holder.map
}

const shadow = new ProjectionShadow()
console.log(`family=${shadow.choose(0)?.kind ?? 'null'}/${shadow.choose(1)?.kind ?? 'null'}/${shadow.choose(2)?.kind ?? 'null'}`)
console.log(
  `union=${readProjectionUnion(true, 0)?.kind ?? 'null'}/${readProjectionUnion(false, 1)?.kind ?? 'null'}/${readProjectionUnion(true, 2)?.kind ?? 'null'}`
)

//! expect: family=null/webgl/cube
//! expect: union=null/webgl/cube
