// @ts-nocheck
//
// A local whose only write before a read is its initializer, though a later
// write stores another class (three's WebGLAttributeUtils.createAttribute:
// `attributeData = new DualAttributeData( attributeData, ... )`). The argument
// read runs before the assignment it feeds, so it sees the initializer's
// record, never the DualAttributeData. The checker types the cell `any`, so
// the read took the cell's whole class|record union, and a class arm with no
// view as the record refused the parameter. The read now takes the arms of
// the writes that reach it (`valuesReachingRead`), and selects its one arm.
let _id = 0
class DualAttributeData {
  constructor(attributeData, dualBuffer) {
    this.buffers = [attributeData.bufferGPU, dualBuffer]
    this.type = attributeData.type
    this.version = attributeData.version
    this.baseId = attributeData.id
    this.activeBufferIndex = 0
  }
  get id() {
    return `${this.baseId}|${this.activeBufferIndex}`
  }
  get bufferGPU() {
    return this.buffers[this.activeBufferIndex]
  }
}
class Backend {
  constructor() {
    this.data = new WeakMap()
  }
  /**
   * @param {Object} object - The object.
   * @param {Object} value - The dictionary to set.
   */
  set(object, value) {
    this.data.set(object, value)
  }
  /**
   * @param {Object} object - The object.
   * @return {Object} The object's dictionary.
   */
  get(object) {
    let map = this.data.get(object)
    if (map === undefined) {
      map = {}
      this.data.set(object, map)
    }
    return map
  }
}
class Utils {
  constructor(backend) {
    this.backend = backend
  }
  createAttribute(attribute, bufferType) {
    const backend = this.backend
    const bufferGPU = { name: 'buf' + attribute.version }
    let attributeData = {
      bufferGPU,
      bufferType,
      type: 5126,
      version: attribute.version,
      id: _id++
    }
    if (attribute.isStorageBufferAttribute) {
      const bufferGPUDual = { name: 'dual' }
      attributeData = new DualAttributeData(attributeData, bufferGPUDual)
    }
    backend.set(attribute, attributeData)
  }
}
const b = new Backend()
const u = new Utils(b)
const a1 = { version: 1, isStorageBufferAttribute: false }
const a2 = { version: 2, isStorageBufferAttribute: true }
u.createAttribute(a1, 34962)
u.createAttribute(a2, 34962)
console.log(b.get(a1).id, b.get(a2).id, b.get(a2).bufferGPU.name)
//! expect: 0 1|0 buf2
