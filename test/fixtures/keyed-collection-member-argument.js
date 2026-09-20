// A keyed-collection method called from JavaScript, with an argument the
// program never typed. `delete`'s parameter is the receiver's own censused
// element -- never `WeakMap<K, V>`'s or `Set<T>`'s open type parameter.
class Texture {
  constructor() {
    this.id = 0
  }
}

/** @type {WeakMap<Texture, number>} */
const videoTextures = new WeakMap()
const htmlTextures = new Set()

function register(texture) {
  videoTextures.set(texture, 1)
  htmlTextures.add(texture)
}

function dispose(event) {
  const texture = event.target
  videoTextures.delete(texture)
  htmlTextures.delete(texture)
}

function run() {
  const t = new Texture()
  register(t)
  dispose({ target: t })
}

export { run }
