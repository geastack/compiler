// @ts-nocheck
//! expect: 1 1 true

// three's `Textures` states `@type {Set<HTMLTexture>}` over a name the file
// never imports, so the field is `Set<any>`: every argument of the statement is
// `any`, and it is still the cell's statement. The census typed the `new Set()`
// from its `.add` writes instead (`Set<Texture>`), and the store into the field
// was a conversion between two Set carriers of one set.
class Texture {
  constructor(id) {
    this.id = id
  }
}
class Textures {
  constructor() {
    /**
     * @type {Set<HTMLTextureNeverImported>}
     */
    this._htmlTextures = new Set()
  }
  /**
   * @param {Texture} texture
   */
  add(texture) {
    this._htmlTextures.add(texture)
    const htmlTextures = this._htmlTextures
    return htmlTextures.size
  }
}
const textures = new Textures()
const t = new Texture(1)
console.log(textures.add(t), textures.add(t), textures._htmlTextures.has(t))
