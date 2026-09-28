// @ts-nocheck
//! expect: 6 4
//! expect: 0
// `CubeRenderTarget.js` hands `CubeTexture` six `{ width, height, depth }`
// records through a slot three's JSDoc types `Array<Image>`. The host states
// `Image` absent, so that slot's element holds no value -- and a real one
// reaches it: the records contradict the tag. The parameter's `[]` default
// does not keep the tag, as a value default otherwise would: an empty array
// holds no element for an absent-element tag to state. Untagged, the
// parameter is what its callers pass, and the default is an empty array of
// the callers' records (`contradicted-jsdoc-parameters.ts`'s
// `holdsNoElement`, `derived-expression-type.ts`'s
// `emptyArrayDefaultParameterOf`). Without a default, see
// `jsdoc-host-absent-parameter-contradicted-by-value.runtime.js`.
class Texture {
	constructor( image ) {
		this.image = image;
	}
}

class CubeTexture extends Texture {
	/** @param {Array<Image>} [images=[]] - An image for each side. */
	constructor( images = [] ) {
		super( images );
		this.isCubeTexture = true;
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

const target = new CubeRenderTarget( 4 );
console.log( target.texture.image.length, target.texture.image[ 5 ].width );
console.log( new CubeTexture().image.length );
