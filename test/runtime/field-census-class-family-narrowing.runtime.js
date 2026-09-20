//! expect: material=background
//! emitted-has: gea::host::instanceOfClassFamilyRef<
//! emitted-has: gea::host::downcastClassRef<
//! emitted-lacks: gea::host::instanceOfClassFamily<

class Material {
  /** @param {string} name */
  constructor(name) {
    this.name = name
  }
}

class BackgroundMaterial extends Material {
  /** @param {string} name */
  constructor(name) {
    super(name)
    this.isBackgroundMaterial = true
  }
}

class Mesh {
  /** @param {Material | Material[]} material */
  constructor(material) {
    /** @type {any} */
    this.material = material
  }
}

/** @param {Material | Material[]} material @returns {Mesh} */
function makeMesh(material) {
  return new Mesh(material)
}

makeMesh(new Material('plain'))
makeMesh([new Material('array')])
const mesh = makeMesh(new BackgroundMaterial('background'))
const material = mesh.material
if (!(material instanceof BackgroundMaterial)) throw new Error('expected background material')
console.log('material=' + material.name)
