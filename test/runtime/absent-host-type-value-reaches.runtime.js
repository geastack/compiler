// @ts-nocheck
//! expect-refusal: ->optional(array-object(undefined,shared-refcount),undefined): a value of array-object(record
// `CubeRenderTarget.js` hands `CubeTexture` six `{ width, height, depth }`
// records through a slot three's JSDoc types `Array<Image>`. The host states
// `Image` absent, so that slot's element holds no value -- and a real one
// reaches it. Converting the record into nothing would drop it (the array
// arrived empty), so the program is refused by name instead. The tag itself
// stands here because the parameter's `[]` default is a value the tag also
// states; without a default, the records contradict it
// (`jsdoc-host-absent-parameter-contradicted-by-value.runtime.js`).
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

