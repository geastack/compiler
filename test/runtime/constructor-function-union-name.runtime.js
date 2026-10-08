// @ts-nocheck
//! expect: names MeshBasicNodeMaterial reinhard | reinhard MeshBasicNodeMaterial
//! expect: anonymous [] []
//! expect: lengths 0 2 | 2 0
//! expect: redefined renamedTone
//! emitted-has: gea::callableDynamicGet(
// `name` and `length` read off a value that is a class or a function, in
// either order of the stated union: three's NodeLibrary.addType warns with
// `nodeClass.name` for a node material class or a tone-mapping function,
// which addMaterial and addToneMapping hand it. Each arm answers its own
// function object's properties, so an anonymous class or arrow reads the
// empty name, and a function's redefined `name` reads the new value.
class Material {}
class MeshBasicNodeMaterial extends Material {}

class Library {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
  }
  /** @param {new () => Material} materialClass */
  material(materialClass) {
    return [this.classFirst(materialClass), this.functionFirst(materialClass)]
  }
  /** @param {(color: number, exposure: number) => number} tone */
  tone(tone) {
    return [this.classFirst(tone), this.functionFirst(tone)]
  }
  /**
   * @param {(new () => Material) | ((color: number, exposure: number) => number)} entry
   * @return {string}
   */
  classFirst(entry) {
    return entry.name + ':' + entry.length
  }
  /**
   * @param {((color: number, exposure: number) => number) | (new () => Material)} entry
   * @return {string}
   */
  functionFirst(entry) {
    return entry.name + ':' + entry.length
  }
}

const library = new Library()
const reinhard = (color, exposure) => color * exposure
const [materialByClass, materialByFunction] = library.material(MeshBasicNodeMaterial)
const [toneByClass, toneByFunction] = library.tone(reinhard)
const nameOf = (entry) => entry.split(':')[0]
const lengthOf = (entry) => entry.split(':')[1]
console.log('names', nameOf(materialByClass), nameOf(toneByClass), '|', nameOf(toneByFunction), nameOf(materialByFunction))
console.log('lengths', lengthOf(materialByClass), lengthOf(toneByClass), '|', lengthOf(toneByFunction), lengthOf(materialByFunction))

// The comma keeps the class expression out of a named binding, so its name is empty.
const AnonymousMaterial = (0, class extends Material {})
const anonymousTone = (() => {
  return (color, exposure) => color + exposure
})()
console.log('anonymous', '[' + nameOf(library.material(AnonymousMaterial)[0]) + ']', '[' + nameOf(library.tone(anonymousTone)[1]) + ']')

const originalTone = (color, exposure) => color - exposure
Object.defineProperty(originalTone, 'name', { value: 'renamedTone' })
console.log('redefined', nameOf(library.tone(originalTone)[0]))
