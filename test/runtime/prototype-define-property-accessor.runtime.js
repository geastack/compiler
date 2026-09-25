// @ts-nocheck
//! expect: runtime 5 true 12
//! expect: setter 21 10
//! expect: own width
// `Object.defineProperty(C.prototype, key, { get() {...} })` with keys from a
// loop -- the shape `NodeMaterial.setDefaultValues` would install copied
// descriptors in. The descriptor's `ThisType<any>` says the getter runs with
// the instance a later read resolved on, so its `this` is that instance, not
// the descriptor literal. (A constant key is a class member to TypeScript's
// JavaScript binder, so it takes the declared-member path instead.)
class ExtBox {
  constructor(width) {
    this.width = width
  }
}
for (const name of ['plusOne', 'plusTwo']) {
  const step = name === 'plusOne' ? 1 : 2
  Object.defineProperty(ExtBox.prototype, name, {
    get() {
      return this.width + step
    }
  })
}
for (const name of ['half']) {
  Object.defineProperty(ExtBox.prototype, name, {
    get() {
      return this.width / 2
    },
    set(value) {
      this.width = value * 2
    }
  })
}
const box = new ExtBox(3)
console.log('runtime', box.plusTwo, box.plusOne === 4, new ExtBox(10).plusTwo)
box.half = 10.5
console.log('setter', box.width, new ExtBox(20).half)
console.log('own', Object.keys(box).join(','))
