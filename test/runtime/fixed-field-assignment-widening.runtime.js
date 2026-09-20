// A freshly allocated required record is narrower than the fixed class field
// that stores it. The field's physical carrier preserves null and the array
// alternative, so an ordinary assignment must rebuild the record arm and then
// explicitly materialize both native sum wrappers.
/** @typedef {{ data?: Uint8Array, width?: number, height?: number, depth?: number }} FixedImage */
/** @typedef {FixedImage|FixedImage[]|null} FixedImageSource */

class FixedSource {
  /** @type {FixedImageSource} */
  data = null
}

const fixedSource = new FixedSource()
const bytes = new Uint8Array([41])
/** @type {{ data: Uint8Array, width: number, height: number }} */
const requiredImage = { data: bytes, width: 2, height: 3 }
fixedSource.data = requiredImage

const storedImage = fixedSource.data
if (storedImage !== null && !Array.isArray(storedImage)) {
  console.log(storedImage.data?.[0], storedImage.width, storedImage.height, storedImage.depth)
}
//! expect: 41 2 3 undefined
