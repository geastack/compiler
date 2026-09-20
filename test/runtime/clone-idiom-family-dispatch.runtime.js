// Root E: three's universal `clone() { return new this.constructor().copy(
// this ) }` idiom (Object3D/Material/Texture/Camera/BufferGeometry/
// RenderTarget), where every subclass overrides `copy` and calls
// `super.copy( source )` first. Proves the whole family dispatches correctly
// end to end -- `new this.constructor()` picking the RUNTIME subclass, and
// `super.copy` reaching the base body -- not just that the reach proof stops
// refusing.
class Base {
  constructor() {
    this.name = 'base'
  }
  /** @param {Base} s */
  copy(s) {
    this.name = s.name
    return this
  }
  clone() {
    return new this.constructor().copy(this)
  }
}
class A extends Base {
  constructor() {
    super()
    this.x = 0
  }
  /** @param {A} s */
  copy(s) {
    super.copy(s)
    this.x = s.x
    return this
  }
}
class B extends Base {
  constructor() {
    super()
    this.y = 0
  }
  /** @param {B} s */
  copy(s) {
    super.copy(s)
    this.y = s.y
    return this
  }
}

const a = new A()
a.name = 'alpha'
a.x = 42
const clonedA = a.clone()
console.log(clonedA.name, clonedA.x, clonedA instanceof A)

const b = new B()
b.name = 'beta'
b.y = 7
const copiedB = new B()
copiedB.copy(b)
console.log(copiedB.name, copiedB.y)

//! expect: alpha 42 true
//! expect: beta 7
