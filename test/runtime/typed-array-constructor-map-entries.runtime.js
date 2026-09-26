// @ts-nocheck
//! expect: int uint float undefined 4 | sint8,snorm8 float32 2 | 2 2 | true,false,false,false
//! emitted-has: gea::mapFromPairArray
// three seeds its typed-array tables from entry arrays (NodeBuilder's
// typeFromArray, WebGPUAttributeUtils's vertex format tables): the checker
// types each Map by the entries, with concrete keys and values, and each
// entry's key keeps the constructor the program named.
const typeFromArray = new Map( [
	[ Int8Array, 'int' ],
	[ Int16Array, 'int' ],
	[ Uint8Array, 'uint' ],
	[ Float32Array, 'float' ]
] );
const prefix = new Map( [
	[ Int8Array, [ 'sint8', 'snorm8' ]],
	[ Float32Array, [ 'float32', ]],
] );
const repeated = new Map( [ [ 'k', 1 ], [ 'j', 3 ], [ 'k', 2 ] ] );
const isInt8 = [];
for ( const key of typeFromArray.keys() ) isInt8.push( key === Int8Array );
console.log( typeFromArray.get( Int16Array ), typeFromArray.get( Uint8Array ), typeFromArray.get( Float32Array ), typeFromArray.get( Uint32Array ), typeFromArray.size, '|', prefix.get( Int8Array ).join( ',' ), prefix.get( Float32Array ).join( ',' ), prefix.size, '|', repeated.get( 'k' ), repeated.size, '|', isInt8.join( ',' ) );
