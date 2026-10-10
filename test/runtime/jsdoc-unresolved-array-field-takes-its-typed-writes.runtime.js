// @ts-nocheck
// A 3D library's shaded material tags `this.uniformsGroups = []` with
// `@type {Array<UniformsGroup>}` but never imports `UniformsGroup`, so the
// checker reads the field as `any[]`. Its only other write is a typed copy;
// the field is stored as that copy's array, so the write keeps the one array
// and a read through a cast receiver sees the same storage.

class Group {
  constructor() {
    this.size = 1
  }
  clone() {
    const group = new Group()
    group.size = this.size + 1
    return group
  }
}

/**
 * @param {Array<Group>} source
 * @return {Array<Group>}
 */
function cloneGroups(source) {
  /** @type {Array<Group>} */
  const copies = []
  for (let index = 0; index < source.length; index++) copies.push(source[index].clone())
  return copies
}

class Holder {
  constructor() {
    /** @type {Array<Unimported>} */
    this.groups = []
  }
  copy(source) {
    const holder = /** @type {Holder} */ (source)
    this.groups = cloneGroups(holder.groups)
    return this
  }
}

const first = new Holder()
first.groups = cloneGroups([new Group()])
const second = new Holder().copy(first)
second.groups.push(new Group())
console.log(first.groups.length, second.groups.length, second.groups[0].size)

//! expect: 1 2 3
