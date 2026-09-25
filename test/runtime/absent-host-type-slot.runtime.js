// @ts-nocheck
//! expect: true 0 true
//! expect: false true
// three.js types its image slots by lib.dom's `Image` (`@param {Image}`,
// `@type {Array<Image>}` in `CubeTexture.js`, `(Image|Object)` in
// `PMREMNode.js`). A JSDoc tag naming a value means that value's type, so the
// slots are `typeof Image` -- a constructor whose construction yields an
// `HTMLImageElement`. The host states `Image` absent, so no value of that type
// exists here: the slots need no native image carrier, an array typed by it
// keeps the array a caller handed it, and a union keeps its real arm.
class Texture {
	/** @param {Object} image */
	constructor( image ) {
		this._image = image;
	}
	get image() { return this._image; }
	set image( value ) { this._image = value; }
}

class CubeTexture extends Texture {
	/** @param {Array<Image>} [images=[]] - An image for each side. */
	constructor( images = [] ) {
		super( images );
		this.isCubeTexture = true;
	}
	/** @type {Array<Image>} */
	get images() { return this.image; }
	set images( value ) { this.image = value; }
}

/**
 * @param {(Image|Object)} image - The equirectangular image.
 * @return {boolean}
 */
function isEquirectangularMapReady( image ) {
	if ( image === null || image === undefined ) return false;
	return image.height > 0;
}

/**
 * @param {?Array<(Image|Object)>} [image] - The cube map image.
 * @return {boolean}
 */
function isCubeMapReady( image ) {
	return image !== null && image !== undefined;
}

/** @type {Array<Image>} */
const mine = [];
const cube = new CubeTexture( mine );
console.log( cube.isCubeTexture, cube.images.length, cube.images === mine );
console.log( isEquirectangularMapReady( null ), isEquirectangularMapReady( { height: 2 } ) || isCubeMapReady( [ { height: 1 } ] ) );
