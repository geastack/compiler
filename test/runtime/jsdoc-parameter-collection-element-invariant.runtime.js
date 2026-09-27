// @ts-nocheck
//! expect: 1 true
// three's `NodeLibrary.addType( nodeClass, type, library )` states `@param
// {Map<string|number, Node.constructor>} library` and is passed both its
// `Map<number, ...>` and its `Map<string, ...>` field. The checker calls each
// assignable to the tag; gea carries a map by its key and value carriers and
// has no conversion that changes one, so each argument contradicts the tag and
// the tag loses.
class MaterialNode {}
class Library {
  constructor() {
    /** @type {Map<string, Function>} */
    this.materialNodes = new Map()
    /** @type {Map<number, Function>} */
    this.toneMappingNodes = new Map()
  }
  addToneMapping(fn, toneMapping) {
    this.addType(fn, toneMapping, this.toneMappingNodes)
  }
  addMaterial(cls, type) {
    this.addType(cls, type, this.materialNodes)
  }
  /**
   * @param {Function} nodeClass
   * @param {number|string} type
   * @param {Map<number|string, Function>} library
   */
  addType(nodeClass, type, library) {
    if (library.has(type)) return
    library.set(type, nodeClass)
  }
}
const lib = new Library()
lib.addToneMapping(() => 1, 3)
lib.addMaterial(MaterialNode, 'basic')
console.log(lib.toneMappingNodes.size + ' ' + lib.materialNodes.has('basic'))
