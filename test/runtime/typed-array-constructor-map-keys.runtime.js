// @ts-nocheck
//! expect: int16 uint8 undefined 3 | false true | 1 1 true 2
//! emitted-has: gea::detail::requireTypedArrayConstructor
// three keys Maps by typed-array constructor (NodeBuilder's typeFromArray,
// WebGPUAttributeUtils's vertex format tables), and tsc folds the keys onto one
// constructor interface. Each constructor keeps its own identity under that
// key type: the Map finds the one the program named, and a key read back as
// the key type is used as that type only when it really is that constructor.
/** @type {Map<Int8ArrayConstructor, string>} */
const typeOf = new Map();
typeOf.set( Int8Array, 'int8' );
typeOf.set( Int16Array, 'int16' );
typeOf.set( Uint8Array, 'uint8' );
/** @param {Int8ArrayConstructor} K */
function describe( K ) {
	return [ new K( 2 ).BYTES_PER_ELEMENT, K.BYTES_PER_ELEMENT, new Int8Array( 1 ) instanceof K, K.from( [ 1, 2 ] ).length ].join( ' ' );
}
const same = [];
let first = '';
for ( const key of typeOf.keys() ) {
	same.push( key === Int8Array );
	if ( first === '' ) first = describe( key );
}
console.log( typeOf.get( Int16Array ), typeOf.get( Uint8Array ), typeOf.get( Float32Array ), typeOf.size, '|', same[ 1 ], same[ 0 ], '|', first );
