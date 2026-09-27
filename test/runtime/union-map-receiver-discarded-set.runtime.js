// @ts-nocheck
//! expect: 1 true 2
// three's `NodeLibrary.addType( nodeClass, type, library )` is passed both a
// `Map<number, ...>` and a `Map<string, ...>` field, so `library` is a union
// of two maps, and a `Set` pair the same way. `library.set( type, nodeClass )`
// discards what `set` returns -- the receiver, which is a different collection
// on each arm -- so the two branches have no common type unless the call is
// discarded on both.
class MaterialNode {}
class Library {
  constructor() {
    /** @type {Map<string, Function>} */
    this.materialNodes = new Map()
    /** @type {Map<number, Function>} */
    this.toneMappingNodes = new Map()
    /** @type {Set<string>} */
    this.names = new Set()
    /** @type {Set<number>} */
    this.ids = new Set()
  }
  addToneMapping(fn, toneMapping) {
    this.addType(fn, toneMapping, this.toneMappingNodes)
    this.addKey(toneMapping, this.ids)
  }
  addMaterial(cls, type) {
    this.addType(cls, type, this.materialNodes)
    this.addKey(type, this.names)
  }
  addType(nodeClass, type, library) {
    if (library.has(type)) return
    library.set(type, nodeClass)
  }
  addKey(key, keys) {
    keys.add(key)
  }
}
const lib = new Library()
lib.addToneMapping(() => 1, 3)
lib.addMaterial(MaterialNode, 'basic')
lib.addToneMapping(() => 2, 4)
console.log(lib.toneMappingNodes.size - 1 + ' ' + lib.materialNodes.has('basic') + ' ' + lib.ids.size)
