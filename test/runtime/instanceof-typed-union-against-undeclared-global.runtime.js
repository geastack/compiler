// @ts-nocheck
//! expect: float32 int16 none
// three's `WebGLAttributeUtils.createAttribute` (`renderers/webgl-fallback/utils/WebGLAttributeUtils.js`):
// `typeof Float16Array !== 'undefined' && array instanceof Float16Array`.
// The global is not declared, so its value is dynamic, and the typed-array
// union on the left is boxed for the dynamic constructor's prototype walk.
// Read off `globalThis` here so a closed script scope cannot fold the guard.
class Attribute {
	/** @param {Float32Array|Int16Array|Uint8Array} array */
	constructor( array ) { this.array = array; }
}
const Float16Array = /** @type {any} */ ( globalThis ).Float16Array;
/** @param {Attribute} attribute */
function kindOf( attribute ) {
	const array = attribute.array;
	if ( array instanceof Float32Array ) return 'float32';
	if ( typeof Float16Array !== 'undefined' && array instanceof Float16Array ) return 'float16';
	if ( array instanceof Int16Array ) return 'int16';
	return 'none';
}
console.log( [ new Attribute( new Float32Array( 2 ) ), new Attribute( new Int16Array( 2 ) ), new Attribute( new Uint8Array( 2 ) ) ].map( kindOf ).join( ' ' ) );
