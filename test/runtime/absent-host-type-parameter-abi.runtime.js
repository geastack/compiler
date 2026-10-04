// @ts-nocheck
//! expect: not ready
//! expect: not ready
// three's CubeMapNode states `@param {Image} image` on
// `isEquirectangularMapReady`, and the host states `Image` absent. The body
// binds such a parameter as `never` (no carrier); the signature's ABI read the
// same tag as lib.dom's `Image` constructor type and declared a native handle,
// so the two frames disagreed and the body had no convention. Both ends now
// read the absent type as `never`.
/**
 * @param {Image} image
 * @return {boolean}
 */
function isEquirectangularMapReady(image) {
  if (image === undefined) return false
  return image.height > 0
}
/**
 * @param {Image} image
 * @return {boolean}
 */
function isReady(image) {
  if (image) return image.height > 0
  return false
}
/** @param {Image} image */
function update(image) {
  console.log(isEquirectangularMapReady(image) ? 'ready' : 'not ready')
  console.log(isReady(image) ? 'ready' : 'not ready')
}
update(undefined)
