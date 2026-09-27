// @ts-nocheck
//! expect: 0 buf1
//! expect: 1|0 buf2
//! expect: 1|1 dual2
// A `let` written with a value its initializer's type does not admit, then
// read after every write: the read may see either write, so it passes the
// stored union, not the checker's declared record (three's
// WebGLAttributeUtils.createAttribute into `backend.set`).
let _id = 0
class DualAttributeData {
  constructor( bufferGPU, dualBuffer, type, id ) {
    this.buffers = [ bufferGPU, dualBuffer ]
    this.type = type
    this.baseId = id
    this.activeBufferIndex = 0
  }
  get id() { return `${ this.baseId }|${ this.activeBufferIndex }` }
  get bufferGPU() { return this.buffers[ this.activeBufferIndex ] }
  switchBuffers() { this.activeBufferIndex ^= 1 }
}
class Backend {
  constructor() { this.data = new WeakMap() }
  /**
   * @param {Object} object - The object.
   * @param {Object} value - The dictionary to set.
   */
  set( object, value ) { this.data.set( object, value ) }
  /**
   * @param {Object} object - The object.
   * @return {Object} The object's dictionary.
   */
  get( object ) {
    let map = this.data.get( object )
    if ( map === undefined ) { map = {}; this.data.set( object, map ) }
    return map
  }
}
class Utils {
  constructor( backend ) { this.backend = backend }
  createAttribute( attribute ) {
    const bufferGPU = { name: 'buf' + attribute.version }
    const id = _id ++
    let attributeData = { bufferGPU, type: 5126, id }
    if ( attribute.isStorageBufferAttribute ) {
      attributeData = new DualAttributeData( bufferGPU, { name: 'dual' + attribute.version }, 5126, id )
    }
    this.backend.set( attribute, attributeData )
  }
}
const b = new Backend()
const u = new Utils( b )
const a1 = { version: 1, isStorageBufferAttribute: false }
const a2 = { version: 2, isStorageBufferAttribute: true }
u.createAttribute( a1 )
u.createAttribute( a2 )
console.log( b.get( a1 ).id, b.get( a1 ).bufferGPU.name )
console.log( b.get( a2 ).id, b.get( a2 ).bufferGPU.name )
b.get( a2 ).switchBuffers()
console.log( b.get( a2 ).id, b.get( a2 ).bufferGPU.name )
export {}
