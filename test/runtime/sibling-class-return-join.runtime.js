// @ts-nocheck
//! expect: plain null
//! expect: narrow 6 false true 1 1
//! expect: wide 6 true false 1 70000
//! expect: direct 6 true false -2 0

// three's `Geometries.getIndex` returns null or a wireframe index built as
// `new ( wide ? Uint32BufferAttribute : Uint16BufferAttribute )( indices, 1 )`,
// and its `@return {?BufferAttribute}` names a class the file does not
// import, so the checker reads the return as `any` and the compiler's
// censuses answer it from the body. The checker merges the two sibling
// constructors' signatures and reduces the result by subtype, so as far as it
// can say only the first class is ever built; they are still two classes.
class Attribute {
  constructor(array, itemSize) {
    this.array = array
    this.itemSize = itemSize
    this.version = 0
  }
}
class Uint16Attribute extends Attribute {}
class Uint32Attribute extends Attribute {}

/** @return {UnimportedAttribute} */
function wireframeIndexOf(vertices) {
  const indices = []
  for (let i = 0; i < 3; i += 3) indices.push(i, i + 1, i + 1, i + 2, i + 2, i)
  if (vertices < 0) return new (vertices < -1 ? Uint32Attribute : Uint16Attribute)(indices, vertices)
  const attribute = new (vertices >= 65535 ? Uint32Attribute : Uint16Attribute)(indices, 1)
  attribute.version = vertices
  return attribute
}

class Geometries {
  /** @return {?UnimportedAttribute} */
  getIndex(vertices, wireframe) {
    let index = null
    if (wireframe === true) index = wireframeIndexOf(vertices)
    return index
  }

  describe(label, vertices, wireframe) {
    const index = this.getIndex(vertices, wireframe)
    if (index === null) console.log(label, 'null')
    else
      console.log(
        label,
        index.array.length,
        index instanceof Uint32Attribute,
        index instanceof Uint16Attribute,
        index.itemSize,
        index.version
      )
  }
}

const geometries = new Geometries()
geometries.describe('plain', 1, false)
geometries.describe('narrow', 1, true)
geometries.describe('wide', 70000, true)
geometries.describe('direct', -2, true)
