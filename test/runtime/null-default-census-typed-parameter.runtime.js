// @ts-nocheck
//! expect: vec3 uint
// three's `StorageBufferNode( value, bufferType = null, ... )` under `@param
// {?(string|Struct)} [bufferType=null]`, with `Struct` a value and no type, so
// the tag says nothing and the parameter is bound from its callers, which all
// pass a string. The default is then never taken, and its `null` still has to
// be a value the binding can hold: the merge of the default is written for it.
class StorageNode {
  /**
   * @param {number} value
   * @param {?(string|Struct)} [bufferType=null]
   */
  constructor(value, bufferType = null) {
    this.value = value
    this.bufferType = bufferType === null ? 'auto' : bufferType
  }
}
console.log(new StorageNode(1, 'vec3').bufferType + ' ' + new StorageNode(2, 'uint').bufferType)
