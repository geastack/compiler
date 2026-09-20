// `this.onUpdate = null` is three's Texture hook; the app never stores a
// function in it, so the guarded call `texture.onUpdate( texture )` can run
// no body. The reach proof refused it as a slot with no implementations, and
// the host-mutation census then read the call as an unauthenticated callee
// handed an opaque argument -- the `*` wildcard for the whole program.
class Texture {
  constructor() {
    this.version = 0
    /** @type {((texture: Texture) => void) | null} */
    this.onUpdate = null
  }
}
/** @param {Texture} texture */
function upload(texture) {
  texture.version++
  if (texture.onUpdate) texture.onUpdate(JSON.parse('{"a":1}'))
  return texture.version
}
const texture = new Texture()
upload(texture)
console.log(upload(texture))
console.log(Object.keys(texture).join(','))
//! expect: 2
//! expect: version,onUpdate
