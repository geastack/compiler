// @ts-nocheck
//! expect-abort
//! emitted-has: gea::detail::requireTypedArrayConstructor
//! expect: 1
// A key that holds Int16Array under the Int8Array key type cannot construct
// through that type: it would build an Int8Array. It stops instead.
/** @type {Map<Int8ArrayConstructor, string>} */
const typeOf = new Map();
typeOf.set( Int8Array, 'int8' );
typeOf.set( Int16Array, 'int16' );
for ( const key of typeOf.keys() ) console.log( new key( 2 ).BYTES_PER_ELEMENT );
