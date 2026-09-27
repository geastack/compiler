// @ts-nocheck
//! expect: 3 changed
// three's `Renderer._quadCache`: `@type {Map<Texture,QuadMesh>}`, but
// `_renderOutput` stores `{ quad, cacheKey }` records through `.set( texture,
// quadData )`, which have none of a `QuadMesh`'s members. The `.set` is a
// store into the field's Map value like a `.push` is into an Array's element,
// so it contradicts the stated value type and the writes decide it.
class Material {
  constructor() {
    this.name = ''
  }
}
class QuadMesh {
  /** @param {Material} material */
  constructor(material) {
    this.material = material
    this.name = ''
  }
  render(renderer) {
    renderer.calls += 1
  }
}
class Texture {
  constructor(id) {
    this.id = id
  }
}
class Renderer {
  constructor() {
    this.calls = 0
    this.cacheKey = 1
    /**
     * @private
     * @type {Map<Texture,QuadMesh>}
     */
    this._quadCache = new Map()
  }
  /** @param {Texture} texture */
  _renderOutput(texture) {
    const cacheKey = this.cacheKey
    let quadData = this._quadCache.get(texture)
    let quad
    if (quadData === undefined) {
      quad = new QuadMesh(new Material())
      quad.name = 'Output Color Transform'
      quadData = {
        quad,
        cacheKey
      }
      this._quadCache.set(texture, quadData)
    } else {
      quad = quadData.quad
      if (cacheKey !== quadData.cacheKey) {
        quad.material.name = 'changed'
        quadData.cacheKey = cacheKey
      }
    }
    quad.render(this)
  }
}
const renderer = new Renderer()
const texture = new Texture(1)
renderer._renderOutput(texture)
renderer._renderOutput(texture)
renderer.cacheKey = 2
renderer._renderOutput(texture)
console.log(renderer.calls, renderer._quadCache.get(texture).quad.material.name)
