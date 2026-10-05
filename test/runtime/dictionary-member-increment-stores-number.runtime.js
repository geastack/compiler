// @ts-nocheck
//! expect: 1 0 2 1:16 0:0 | 0 0
// `memory` is a dictionary, so `memory.geometries` reads `number | undefined`
// out of it. `++` on that read is ToNumeric of it plus one -- always a number --
// and the store writes that number back. three's `Info.memory` (counted by `this.memory[ type ] ++`)
// and `Geometries`/`Textures`, which count into it with `++`/`--`.
class Info {
  constructor() {
    /** @type {Record<string, number>} */
    this.memory = { attributes: 0, attributesSize: 0, geometries: 0, textures: 0 }
    this.memoryMap = new Map()
  }
  /**
   * @param {Object} attribute
   * @param {string} type
   */
  createAttribute(attribute, type) {
    const size = 16
    this.memoryMap.set(attribute, { size, type })
    this.memory[type]++
    this.memory[type + 'Size'] += size
  }
  /** @param {Object} attribute */
  destroyAttribute(attribute) {
    const data = this.memoryMap.get(attribute)
    if (data) {
      this.memoryMap.delete(attribute)
      this.memory[data.type]--
      this.memory[data.type + 'Size'] -= data.size
    }
  }
  reset() {
    for (const prop in this.memory) this.memory[prop] = 0
  }
}
class Geometries {
  /** @param {Info} info */
  constructor(info) {
    this.info = info
  }
  add() {
    this.info.memory.geometries++
  }
  remove() {
    this.info.memory.geometries--
  }
}
const info = new Info()
const geometries = new Geometries(info)
geometries.add()
const first = info.memory.geometries
geometries.remove()
const second = info.memory.geometries
geometries.add()
geometries.add()
const third = info.memory.geometries
const attribute = {}
info.createAttribute(attribute, 'attributes')
const created = info.memory.attributes + ':' + info.memory.attributesSize
info.destroyAttribute(attribute)
const destroyed = info.memory.attributes + ':' + info.memory.attributesSize
info.reset()
console.log(first, second, third, created, destroyed, '|', info.memory.geometries, info.memory.textures)
