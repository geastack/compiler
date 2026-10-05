// @ts-nocheck
//! expect: binding b 1 undefined undefined true
//! expect: buffer u 2 4 7 true false
//! expect: keys bytesPerElement,id,name,visibility
// three's `Binding.clone()` is `Object.assign( new this.constructor(), this )`
// in the base class, so its source is typed as `Binding` while the instance
// may be a `UniformBuffer`. `Binding` carries overlays for `bytesPerElement` and `id`
// (type evidence from its subclasses), but nothing reads them through a
// `Binding`, so its native storage omits them and `UniformBuffer` holds them. The
// copy read them as members of the `Binding` struct, which has none, and a
// subclass instance has to hand over its own fields however the source is typed.
class Binding {
  /** @type {number | undefined}
   * @geaSubclassMemberOverlay */
  bytesPerElement
  /** @type {number | undefined}
   * @geaSubclassMemberOverlay */
  id
  constructor(name = '') {
    this.name = name
    this.visibility = 0
  }
  setVisibility(visibility) {
    this.visibility |= visibility
  }
  clone() {
    return Object.assign(new this.constructor(), this)
  }
}
class UniformBuffer extends Binding {
  constructor(name, bytesPerElement) {
    super(name)
    this.bytesPerElement = bytesPerElement
    this.id = 7
  }
}
const binding = new Binding('b')
binding.setVisibility(1)
const bindingCopy = binding.clone()
console.log(
  'binding',
  bindingCopy.name,
  bindingCopy.visibility,
  bindingCopy.bytesPerElement,
  bindingCopy.id,
  bindingCopy instanceof Binding
)
const buffer = new UniformBuffer('u', 4)
buffer.setVisibility(2)
const bufferCopy = buffer.clone()
console.log(
  'buffer',
  bufferCopy.name,
  bufferCopy.visibility,
  bufferCopy.bytesPerElement,
  bufferCopy.id,
  bufferCopy instanceof UniformBuffer,
  bufferCopy === buffer
)
console.log('keys', Object.keys(bufferCopy).sort().join(','))
