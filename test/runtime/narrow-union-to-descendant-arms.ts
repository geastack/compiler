// A cell declared at a BASE class, assigned two DERIVED classes, and read back
// at what the assignment proved. TypeScript narrows `result` to
// `Distance | Depth` after the assignment, so the reads past it ask for
// `tagged-union(undefined|null|Base) -> tagged-union(Distance|Depth)` -- an
// arm subset whose arms are descendants of the source's own arm, which
// `conversion/build.ts` never proposed because `narrowingTargetsOf` answers
// from the carrier alone and a `class-ref(Base)` states nothing about which
// classes descend from it. three's `WebGLShadowMap.getDepthMaterial` is the
// shape, twice on one cell.
class Surface {
  kind: string
  visible = false
  constructor(kind: string) {
    this.kind = kind
  }
}

class Depth extends Surface {
  bias = 1
  constructor() {
    super('depth')
  }
}

class Distance extends Surface {
  far = 2
  constructor() {
    super('distance')
  }
}

const shared = { depth: new Depth(), distance: new Distance() }

const pick = (point: boolean, custom: Surface | null | undefined): string => {
  let result: Surface | null | undefined
  if (custom !== undefined && custom !== null) {
    result = custom
    return `custom:${result.kind}:${String(result.visible)}`
  }
  result = point ? shared.distance : shared.depth
  result.visible = true
  return `derived:${result.kind}:${String(result.visible)}`
}

console.log(`point=${pick(true, undefined)}`)
console.log(`plain=${pick(false, null)}`)
console.log(`custom=${pick(false, new Surface('custom'))}`)

//! expect: point=derived:distance:true
//! expect: plain=derived:depth:true
//! expect: custom=custom:custom:false
