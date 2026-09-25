// @ts-nocheck
//! expect: none
//! expect: narrow 1 2
//! expect: wide 70000 2
//! expect: built narrow 1 2
//! expect: built wide 70000 2

// A field written with a `new` through a choice of two sibling classes (the
// field form of three's `new ( wide ? Uint32BufferAttribute :
// Uint16BufferAttribute )( indices, 1 )`). The checker joins the field's
// writes by subtype, as it does the `new`, and answers one class; the field
// holds either, so it is laid out as their union, and reading it back sees
// whichever was built.
class Attribute {
  constructor(array, itemSize) {
    this.array = array
    this.itemSize = itemSize
    this.version = 0
  }
}
class Uint16Attribute extends Attribute {}
class Uint32Attribute extends Attribute {}
class Holder {
  constructor() {
    this.index = null
  }
  build(vertices) {
    this.index = new (vertices >= 65535 ? Uint32Attribute : Uint16Attribute)([0, 1], 2)
    this.index.version = vertices
  }
  describe() {
    const index = this.index
    if (index === null) return 'none'
    return (index instanceof Uint32Attribute ? 'wide' : 'narrow') + ' ' + index.version + ' ' + index.array.length
  }
}
const holder = new Holder()
console.log(holder.describe())
holder.build(1)
console.log(holder.describe())
holder.build(70000)
console.log(holder.describe())

class Built {
  constructor(vertices) {
    this.index = new (vertices >= 65535 ? Uint32Attribute : Uint16Attribute)([0, 1], 2)
    this.index.version = vertices
  }
  describe() {
    const index = this.index
    return 'built ' + (index instanceof Uint32Attribute ? 'wide' : 'narrow') + ' ' + index.version + ' ' + index.array.length
  }
}
console.log(new Built(1).describe())
console.log(new Built(70000).describe())
