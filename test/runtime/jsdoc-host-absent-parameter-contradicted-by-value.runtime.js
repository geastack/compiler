// @ts-nocheck
//! expect: 6 4
//! expect: true
// three's `CubeTexture` states `@param {Array<Image>} [images=[]]` and
// `CubeMapNode.js` `@param {Image} image`: lib.dom's `Image`, which the host
// states absent. No value on this host is an `Image`, so a tag naming only
// that type states a slot nothing can fill, and a value that is there
// contradicts it: `CubeRenderTarget` hands `CubeTexture` six `{ width,
// height, depth }` records. Read at the tag, the records converted into
// nothing and the program was refused.
class CubeTexture {
  /** @param {Array<Image>} images - An image for each side. */
  constructor(images) {
    this.images = images
  }
}
class CubeRenderTarget {
  /** @param {number} [size=1] */
  constructor(size = 1) {
    const image = { width: size, height: size, depth: 1 }
    const images = [image, image, image, image, image, image]
    this.texture = new CubeTexture(images)
  }
}
const target = new CubeRenderTarget(4)
console.log(target.texture.images.length, target.texture.images[0].width)
/**
 * @param {Image} image
 * @return {boolean}
 */
function isEquirectangularMapReady(image) {
  if (image === null || image === undefined) return false
  return image.height > 0
}
console.log(isEquirectangularMapReady({ height: 2 }))
