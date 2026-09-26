// @ts-nocheck
// three's TSLCore.js: each bare `new Map()` cache is also held by a slot of
// the `cacheMaps` literal, and all four maps reach `ConvertType`'s one
// `cacheMap` parameter. The literal slot keeps the checker's `Map<any, any>`,
// so the bare maps keep it too rather than a narrower census answer that
// would make one storage two carriers. `[...map]` then yields `[k, v]`
// Arrays, and `new Map(array)` reads each element's "0" and "1" -- a
// `ConstNode` has neither, so it adds `undefined -> undefined`, as in Node.
class ConstNode {
	/**
	 * @param {any} value
	 * @param {?string} type
	 */
	constructor( value, type = null ) { this.value = value; this.type = type; this.isNode = true }
}
const bools = [ false, true ];
const uints = [ 0, 1, 2, 3 ];
const ints = [ - 1, - 2 ];
const floats = [ 0.5, 1.5 ];
const boolsCacheMap = new Map();
for ( const bool of bools ) boolsCacheMap.set( bool, new ConstNode( bool ) );
const uintsCacheMap = new Map();
for ( const uint of uints ) uintsCacheMap.set( uint, new ConstNode( uint, 'uint' ) );
const intsCacheMap = new Map( [ ...uintsCacheMap ].map( el => new ConstNode( el.value, 'int' ) ) );
for ( const int of ints ) intsCacheMap.set( int, new ConstNode( int, 'int' ) );
const floatsCacheMap = new Map( [ ...intsCacheMap ].map( el => new ConstNode( el.value ) ) );
for ( const float of floats ) floatsCacheMap.set( float, new ConstNode( float ) );
for ( const float of floats ) floatsCacheMap.set( - float, new ConstNode( - float ) );
const cacheMaps = { bool: boolsCacheMap, uint: uintsCacheMap, ints: intsCacheMap, float: floatsCacheMap };
const constNodesCacheMap = new Map( [ ...boolsCacheMap, ...floatsCacheMap ] );
const ConvertType = function ( type, cacheMap = null ) {
	return ( ...params ) => {
		if ( params.length === 1 && cacheMap !== null && cacheMap.has( params[ 0 ] ) ) return cacheMap.get( params[ 0 ] );
		return new ConstNode( params[ 0 ], type );
	};
};
const float = new ConvertType( 'float', cacheMaps.float );
const int = new ConvertType( 'int', cacheMaps.ints );
const uint = new ConvertType( 'uint', cacheMaps.uint );
const bool = new ConvertType( 'bool', cacheMaps.bool );
console.log( bool( true ).value, uint( 2 ).type, int( -1 ).type, float( 0.5 ).value, float( 7 ).value )
console.log( intsCacheMap.size, intsCacheMap.has( undefined ), floatsCacheMap.size, constNodesCacheMap.size, constNodesCacheMap.get( -1.5 ).value )
//! expect: true uint int 0.5 7
//! expect: 3 true 5 7 -1.5
