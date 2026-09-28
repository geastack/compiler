// @ts-nocheck
//! expect: 6 4
//! expect: 0
// A parameter typed by nothing but an empty `[]` default is what its callers
// pass, as one typed by a `null` default is: the checker's `any[]` is the
// default's, an array with no element to state. three's `CubeTexture(
// images = [] )`, once its tag is blanked, hands `images` to `Texture(
// image )`, and `CubeRenderTarget` passes six `{ width, height, depth }`
// records. Read as the checker's `any[]`, `images` bound `Texture`'s `image`
// to a dynamic array before its own callers were read, and the default boxed
// as an unstated array with no conversion into the callers' records.
class Texture {
	constructor( image ) {
		this.image = image;
	}
}

class CubeTexture extends Texture {
	constructor( images = [] ) {
		super( images );
		this.isCubeTexture = true;
	}
}

const image = { width: 4, height: 4, depth: 1 };
const texture = new CubeTexture( [ image, image, image, image, image, image ] );
console.log( texture.image.length, texture.image[ 5 ].width );
console.log( new CubeTexture().image.length );
