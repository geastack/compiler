// @ts-nocheck
//! expect-refusal: ->optional(array-object(undefined,shared-refcount),undefined): a value of array-object(record
//! expect-refusal: ->undefined: a value of record(
// `CubeRenderTarget.js` hands `CubeTexture` six `{ width, height, depth }`
// records through a slot three's JSDoc types `Array<Image>`. The host states
// `Image` absent, so that slot's element holds no value -- and a real one
// reaches it. Converting the record into nothing would drop it (the array
// arrived empty), so the program is refused by name instead. So is a record
// handed to a parameter typed `Image` alone, which would otherwise arrive as
// `undefined` and answer `false`.
class CubeTexture {
	/** @param {Array<Image>} [images=[]] - An image for each side. */
	constructor( images = [] ) {
		this.images = images;
	}
}

class CubeRenderTarget {
	/** @param {number} [size=1] */
	constructor( size = 1 ) {
		const image = { width: size, height: size, depth: 1 };
		const images = [ image, image, image, image, image, image ];
		this.texture = new CubeTexture( images );
	}
}

console.log( new CubeRenderTarget( 4 ).texture.images.length );

/**
 * @param {Image} image - `CubeMapNode.js`'s own tag for the same slot.
 * @return {boolean}
 */
function isEquirectangularMapReady( image ) {
	if ( image === null || image === undefined ) return false;
	return image.height > 0;
}

console.log( isEquirectangularMapReady( { height: 2 } ) );
