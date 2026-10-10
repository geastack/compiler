// A 3D scene-graph library's `Source` defines its `id` with `Object.defineProperty(this, 'id',
// { value })` and never declares the field. That literal key names one own
// data property; it must not publish the whole instance (and every structural
// record its fields reach) to the unrestricted dynamic property protocol.
let nextId = 0

class Source {
  /** @param {any} [data=null] */
  constructor(data = null) {
    this.isSource = true
    Object.defineProperty(this, 'id', { value: nextId++ })
    this.uuid = 'u' + nextId
    this.data = data
    this.version = 0
  }

  /** @param {boolean} value */
  set needsUpdate(value) {
    if (value === true) this.version++
  }
}

class Texture {
  /** @param {{ width: number, height: number, image?: any }[]} images */
  constructor(images) {
    this.source = new Source(images)
  }
  get image() {
    return this.source.data
  }
}

const first = new Texture([{ width: 2, height: 3 }])
const second = new Texture([{ width: 4, height: 5, image: { width: 6, height: 7 } }])
second.source.needsUpdate = true
const empty = new Source()
const read = (/** @type {any} */ value) => value.id
console.log(
  read(first.source),
  read(second.source),
  read(empty),
  empty.data === null,
  Object.keys(second.source).join(','),
  second.image.length,
  second.source.version
)
//! expect: 0 1 2 true isSource,uuid,data,version 1 1

try {
  ;/** @type {any} */ (first.source).id = 9
} catch (error) {
  console.log(error instanceof Error ? error.name : 'unexpected', read(first.source))
}
//! expect: TypeError 0
