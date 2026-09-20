// The exact shape of three.js's `WebGLTextures.uploadCubeTexture` as the
// native-webgl-angle plugin rewrites it: an empty array literal is filled by
// index assignment inside a fixed loop from two different writes -- a typed
// helper call, and a ternary whose two arms are two record shapes (a
// data-texture face's nested `.image` record, or the face itself). Every arm
// is well typed; nothing here is `any`. The helper is stated explicitly
// because this fixture exercises the ARRAY census alone (no parameter census
// is composed in the test), and an unannotated pass-through helper would be a
// question for that other census, not for the ternary this pins.

/** @typedef {{ data?: Uint8Array, width?: number, height?: number, depth?: number }} ImageRecord */
/** @typedef {{ data?: Uint8Array, width?: number, height?: number, depth?: number, isDataTexture?: boolean, image?: ImageRecord }} Face */

/**
 * @param {ImageRecord|Face[]|null} value
 * @return {Face[]}
 */
function requireFaces(value) {
  if (Array.isArray(value)) return value
  throw new Error('cube texture image must be an array')
}

/** @param {Face} image @param {boolean} needsNewCanvas @param {number} maxSize @return {Face} */
function resizeImage(image, needsNewCanvas, maxSize) {
  return image
}

/** @param {ImageRecord|Face[]|null} source @param {boolean} compressed */
function upload(source, compressed) {
  const faces = requireFaces(source)
  if (faces.length !== 6) return 0
  const isDataTexture = faces[0] && faces[0].isDataTexture
  const cubeImage = []
  for (let i = 0; i < 6; i++) {
    if (!compressed && !isDataTexture) {
      cubeImage[i] = resizeImage(faces[i], true, 4096)
    } else {
      cubeImage[i] = isDataTexture ? faces[i].image : faces[i]
    }
  }
  let total = 0
  for (let i = 0; i < 6; i++) {
    const face = cubeImage[i]
    if (face && typeof face.width === 'number') total += face.width
  }
  return total
}

const faces = []
for (let i = 0; i < 6; i++) faces.push({ width: 4, height: 4, data: new Uint8Array(64) })
console.log(upload(faces, false))
