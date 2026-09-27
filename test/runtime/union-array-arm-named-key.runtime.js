// @ts-nocheck
//! expect: false false true | 200 2
// A named key off `number | Array<number> | Attribute` that neither a
// number nor an Array declares: the number and the array answer
// `undefined`, the class its field. three's `Backend.compute` tests
// `dispatchSize.isIndirectStorageBufferAttribute` this way.
class IndirectAttribute {
  constructor() {
    this.isIndirectAttribute = true
  }
}
/** @param {number|Array<number>|IndirectAttribute} size */
const isIndirect = (size) => {
  if (!size) return false
  if (size.isIndirectAttribute) return true
  return false
}
/** @param {number|Array<number>|IndirectAttribute} size */
const countOf = (size) => (typeof size === 'number' ? size : Array.isArray(size) ? size.length : 0)
console.log(isIndirect(200), isIndirect([2, 3, 4]), isIndirect(new IndirectAttribute()), '|', countOf(200), countOf([1, 2]))
export {}
