// A named read through a string index signature whose value is a union
// array: `morphAttributes.position` on three's `BufferGeometry`.
class Attr {
  constructor(n) {
    this.count = n
  }
}
class InterleavedAttr {
  constructor(n) {
    this.count = n * 2
  }
}
class Geometry {
  constructor() {
    /** @type {{[name: string]: Array<Attr|InterleavedAttr>|undefined}} */
    this.morphAttributes = {}
  }
}
function report(geometry) {
  const morphAttributes = geometry.morphAttributes
  if (morphAttributes.position !== undefined || morphAttributes.normal !== undefined) {
    console.log('has morph', morphAttributes.position.length)
  } else {
    console.log('no morph')
  }
}
const g = new Geometry()
report(g)
g.morphAttributes.position = [new Attr(1), new InterleavedAttr(2)]
report(g)
